//! Readiness probe + dashboard snapshot assembly.
//!
//! The probe answers ONE question a bare TCP connect cannot: is an app actually
//! listening behind a published port? Docker publishes the host→container mapping
//! the moment the container starts — minutes before a heavy AI app binds its
//! socket — and docker-proxy itself accepts the TCP connection even when nothing
//! listens inside (measured). So `ready` demands a real HTTP exchange, limited to
//! the manifest's `web: true` ports (browser UIs). Probing an arbitrary TCP port
//! with HTTP would read as "never ready" and spin the warming poll forever.
//!
//! [`build_snapshot`] is the engine/store/probe orchestration; the two-loop Channel
//! pump that drives it (event-driven + warming/safety refresh, serialize + coalesce)
//! lives in the desktop crate.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use futures_util::future::join_all;

use crate::endpoint::{Endpoint, parse_docker_host};
use crate::recipe::instance::list_instances;
use crate::view::{ContainerStatus, to_container_statuses};
use crate::{DOCKER_HOST_ENV, EngineHandle, Error, brand};

/// Probe budget per port.
const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

/// A managed-container snapshot for the dashboard: the probed container statuses
/// plus a `warming` flag — a running web port is published but not yet accepting,
/// so the caller should poll FAST until it flips (no Docker event fires when the
/// app finally binds its socket).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotPush {
    pub containers: Vec<ContainerStatus>,
    pub warming: bool,
}

/// True iff an HTTP GET to `host:port` gets ANY response (2xx/3xx/4xx/5xx) within
/// `timeout`. A bare TCP connect is deliberately NOT enough (docker-proxy accepts
/// it with nothing behind), so only a real HTTP answer counts. Redirects are NOT
/// followed — a 3xx is itself a response (`redirects(0)`). Blocking (ureq);
/// callers run it under `spawn_blocking`.
fn probe_accepts(host: &str, port: u32, timeout: Duration) -> bool {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(timeout)
        .timeout_read(timeout)
        .redirects(0)
        .build();
    match agent.get(&format!("http://{host}:{port}/")).call() {
        Ok(_) => true,
        // The server ANSWERED with a non-2xx (incl. a 3xx redirect) — the app is up.
        Err(ureq::Error::Status(_, _)) => true,
        // Refused / reset by docker-proxy / timeout / non-HTTP → not accepting.
        Err(ureq::Error::Transport(_)) => false,
    }
}

/// The host where published ports actually live: the Docker daemon's host (the
/// remote host for a TCP endpoint, loopback for the local unix/npipe daemon).
pub fn probe_host(endpoint: &Endpoint) -> String {
    match endpoint {
        Endpoint::Tcp { host, .. } => host.clone(),
        Endpoint::Unix { .. } | Endpoint::Npipe { .. } => "127.0.0.1".to_string(),
    }
}

/// Resolve the probe host from the same env the engine connects with
/// (`COMPOSITZ_DOCKER_HOST`), defaulting to loopback for the local daemon.
fn resolve_probe_host() -> String {
    match std::env::var(DOCKER_HOST_ENV) {
        Ok(raw) if !raw.is_empty() => parse_docker_host(&raw)
            .map(|endpoint| probe_host(&endpoint))
            .unwrap_or_else(|_| "127.0.0.1".to_string()),
        _ => "127.0.0.1".to_string(),
    }
}

/// instanceId → the manifest's `web: true` container ports (what the probe targets).
/// Best-effort by construction: [`list_instances`] swallows an unreadable store to an
/// empty list, so a bad store round probes nothing and `ready` degrades visibly to
/// "starting…" rather than to a false "ready".
fn web_ports_by_instance(store: &str) -> HashMap<String, HashSet<u32>> {
    let mut map = HashMap::new();
    for inst in list_instances(store) {
        let web = inst
            .manifest
            .ports
            .iter()
            .filter(|p| p.web)
            .map(|p| p.container)
            .collect();
        map.insert(inst.instance_id, web);
    }
    map
}

/// Enrich container statuses with per-port `accepting` (parallel HTTP probes).
/// Probed: a RUNNING container's ports that `web_ports` names for its instance;
/// everything else passes through unprobed (`accepting` stays `None` ⇒ never a
/// false "ready").
pub async fn enrich_with_probes(
    statuses: Vec<ContainerStatus>,
    host: &str,
    web_ports: &HashMap<String, HashSet<u32>>,
) -> Vec<ContainerStatus> {
    let host = host.to_string();
    let per_container = statuses.into_iter().map(|s| {
        let running = s.state == "running";
        // Own the web set per container so no borrow of `web_ports` crosses an await.
        let web: HashSet<u32> = s
            .instance
            .as_ref()
            .and_then(|i| web_ports.get(i))
            .cloned()
            .unwrap_or_default();
        let host = host.clone();
        async move {
            let ports = join_all(s.ports.into_iter().map(|mut p| {
                let probe_this = running && web.contains(&p.container);
                let host = host.clone();
                async move {
                    if probe_this {
                        let public = p.public;
                        p.accepting = Some(
                            tokio::task::spawn_blocking(move || {
                                probe_accepts(&host, public, PROBE_TIMEOUT)
                            })
                            .await
                            .unwrap_or(false),
                        );
                    }
                    p
                }
            }))
            .await;
            ContainerStatus {
                instance: s.instance,
                state: s.state,
                ports,
            }
        }
    });
    join_all(per_container).await
}

/// Assemble one dashboard snapshot: list managed containers → reduce to statuses →
/// probe the running web ports → detect `warming`. An engine error propagates (the
/// caller turns it into an "offline" push).
pub async fn build_snapshot(handle: &EngineHandle, store: &str) -> Result<SnapshotPush, Error> {
    let raw = handle.list_managed_raw().await?;
    let statuses = to_container_statuses(&raw, &brand::label("instance"));
    let web_ports = web_ports_by_instance(store);
    let host = resolve_probe_host();
    let containers = enrich_with_probes(statuses, &host, &web_ports).await;
    // Warming counts only PROBED ports (accepting == Some(false)) — an unprobed port
    // must not spin the fast poll forever.
    let warming = containers
        .iter()
        .any(|c| c.state == "running" && c.ports.iter().any(|p| p.accepting == Some(false)));
    Ok(SnapshotPush {
        containers,
        warming,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::view::PublishedPort;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    /// Spawn a one-shot listener that, on the first connection, runs `handle` with
    /// the accepted stream, then returns. Yields the bound port. The thread is
    /// detached; each test connects exactly once.
    fn spawn_listener(handle: impl FnOnce(TcpStream) + Send + 'static) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                handle(stream);
            }
        });
        port
    }

    /// A responder that reads the request then writes a fixed status line.
    fn respond_with(status_line: &'static str) -> impl FnOnce(TcpStream) + Send + 'static {
        move |mut stream: TcpStream| {
            let mut buf = [0u8; 512];
            let _ = stream.read(&mut buf);
            let _ = stream.write_all(
                format!("HTTP/1.1 {status_line}\r\nContent-Length: 0\r\n\r\n").as_bytes(),
            );
            let _ = stream.flush();
        }
    }

    /// A closed-but-listening port: bind, capture the port, drop the listener — a
    /// connect there is refused (nothing is listening).
    fn refused_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    #[test]
    fn probe_accepts_true_for_any_http_answer_including_404_and_redirect() {
        let ok = spawn_listener(respond_with("200 OK"));
        assert!(probe_accepts("127.0.0.1", u32::from(ok), PROBE_TIMEOUT));

        let not_found = spawn_listener(respond_with("404 Not Found"));
        assert!(probe_accepts(
            "127.0.0.1",
            u32::from(not_found),
            PROBE_TIMEOUT
        ));

        // A 3xx is a response too (redirects are not followed) — the app is up.
        let redirect = spawn_listener(respond_with("302 Found"));
        assert!(probe_accepts(
            "127.0.0.1",
            u32::from(redirect),
            PROBE_TIMEOUT
        ));
    }

    #[test]
    fn probe_rejects_a_port_that_accepts_tcp_but_never_speaks_http() {
        // THE docker-proxy trap: the connection succeeds but no HTTP answer comes.
        // A short timeout keeps the test fast; the point is the timeout ⇒ NOT ready.
        let silent = spawn_listener(|stream| {
            // Hold the accepted connection open, never writing a response.
            thread::sleep(Duration::from_millis(400));
            drop(stream);
        });
        assert!(!probe_accepts(
            "127.0.0.1",
            u32::from(silent),
            Duration::from_millis(150)
        ));
    }

    #[test]
    fn probe_rejects_a_refused_connection() {
        assert!(!probe_accepts(
            "127.0.0.1",
            u32::from(refused_port()),
            Duration::from_millis(300)
        ));
    }

    #[test]
    fn probe_host_is_the_tcp_host_else_loopback() {
        assert_eq!(
            probe_host(&Endpoint::Tcp {
                host: "host.docker.internal".to_string(),
                port: 2375,
            }),
            "host.docker.internal"
        );
        assert_eq!(
            probe_host(&Endpoint::Unix {
                path: "/var/run/docker.sock".to_string(),
            }),
            "127.0.0.1"
        );
        assert_eq!(
            probe_host(&Endpoint::Npipe {
                path: "\\\\.\\pipe\\docker_engine".to_string(),
            }),
            "127.0.0.1"
        );
    }

    fn status(instance: &str, state: &str, ports: Vec<PublishedPort>) -> ContainerStatus {
        ContainerStatus {
            instance: Some(instance.to_string()),
            state: state.to_string(),
            ports,
        }
    }

    fn port(container: u32, public: u32) -> PublishedPort {
        PublishedPort {
            container,
            public,
            protocol: "tcp".to_string(),
            accepting: None,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn enrich_probes_only_running_web_ports_leaving_the_rest_unprobed() {
        // A live web server answers on `web_public`; a second (non-web) port is not
        // probed even though it maps to a real container port.
        let web_public = spawn_listener(respond_with("200 OK"));

        let mut web_ports: HashMap<String, HashSet<u32>> = HashMap::new();
        web_ports.insert("app-a1b2c3".to_string(), HashSet::from([8080]));

        let statuses = vec![
            // running: web port (8080) probed → accepting Some(true); the 9090 port
            // is NOT a web port for this instance → stays None even if it were open.
            status(
                "app-a1b2c3",
                "running",
                vec![port(8080, u32::from(web_public)), port(9090, 12345)],
            ),
            // stopped: its web port is NOT probed (only running containers are).
            status(
                "app-a1b2c3",
                "exited",
                vec![port(8080, u32::from(web_public))],
            ),
            // running but no web ports declared for this instance → nothing probed.
            status(
                "other-z9y8x7",
                "running",
                vec![port(8080, u32::from(web_public))],
            ),
        ];

        let out = enrich_with_probes(statuses, "127.0.0.1", &web_ports).await;

        assert_eq!(
            out[0].ports[0].accepting,
            Some(true),
            "running web port probed"
        );
        assert_eq!(
            out[0].ports[1].accepting, None,
            "non-web port left unprobed"
        );
        assert_eq!(
            out[1].ports[0].accepting, None,
            "stopped container not probed"
        );
        assert_eq!(
            out[2].ports[0].accepting, None,
            "instance with no web ports not probed"
        );
    }
}
