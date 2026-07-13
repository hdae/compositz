//! Engine access over a subprocess's stdio (the `docker system dial-stdio`
//! shape).
//!
//! WSL Containers (wslc) publishes NEITHER a named pipe NOR a TCP port for its
//! moby daemon; the only doorway is a bridge process
//! (`wslc system session run docker system dial-stdio`) whose stdin/stdout is
//! one raw connection to the engine's HTTP API. This module turns any such
//! command into a bollard [`Docker`]: a hyper connector spawns ONE bridge
//! process per pooled HTTP connection and adapts the child's stdio into the
//! connection stream, then bollard drives its normal protocol over it via
//! `connect_with_custom_transport` (no bollard fork).
//!
//! NOTE: the wslc invocation is implementation-reported (see
//! fabric8io/docker-maven-plugin#1928), not a documented contract — the exact
//! argv MUST be re-verified against a real Windows machine when wslc updates.

use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::task::{Context, Poll};

use bollard::{API_DEFAULT_VERSION, Docker};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection};
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::error::Error;

/// The wslc bridge command. `wslc` resolves via `PATH` (`wslc.exe` on Windows).
pub(crate) const WSLC_DIAL_ARGV: &[&str] = &[
    "wslc",
    "system",
    "session",
    "run",
    "docker",
    "system",
    "dial-stdio",
];

/// Connect to an engine reachable over the stdio of `argv` — a
/// `docker system dial-stdio`-shaped bridge command. Construction is fully
/// lazy: nothing is spawned until the first request, and hyper's connection
/// pool keeps each bridge process alive for connection reuse exactly like a
/// kept-alive TCP socket.
pub fn connect_dial_stdio(argv: &[&str], timeout_secs: u64) -> Result<Docker, Error> {
    let connector = DialStdioConnector {
        argv: Arc::new(argv.iter().map(|s| s.to_string()).collect()),
    };
    let mut builder = Client::builder(TokioExecutor::new());
    // Without a pool timer, hyper-util NEVER reclaims idle connections (the
    // 90s idle default is inert with the `pool_timer: None` builder default) —
    // each idle connection here is a live bridge PROCESS, so unreclaimed idles
    // would pile up wslc.exe sessions until app exit (and could keep the WSL
    // utility VM awake). The timer makes the idle expiry real.
    builder.pool_timer(hyper_util::rt::TokioTimer::new());
    // The body type parameter stays inferred (bollard's `BodyType` is not
    // public); `client.request(req)` below pins it to the request's own type.
    let client = Arc::new(builder.build(connector));
    let docker = Docker::connect_with_custom_transport(
        move |req: bollard::BollardRequest| {
            let client = Arc::clone(&client);
            Box::pin(async move { client.request(req).await.map_err(describe_client_error) })
        },
        // Only a label: it becomes the scheme/authority of the internal request
        // URIs (and hyper's single pool key) — no network meaning.
        Some("dial-stdio://bridge"),
        timeout_secs,
        API_DEFAULT_VERSION,
    )?;
    Ok(docker)
}

/// Flatten a hyper client error's SOURCE CHAIN into the message. hyper's
/// `Display` hides sources ("client error (Connect)") — but the chain is where
/// the actionable part lives (e.g. ``failed to spawn dial-stdio bridge
/// `wslc`: …``), and `doctor` prints exactly this Display. Without the
/// flattening, a missing wslc and a dead daemon would be indistinguishable.
fn describe_client_error(err: hyper_util::client::legacy::Error) -> bollard::errors::Error {
    let mut text = err.to_string();
    let mut source = std::error::Error::source(&err);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    bollard::errors::Error::IOError {
        err: std::io::Error::other(text),
    }
}

/// A hyper connector that "connects" by spawning the bridge command.
#[derive(Clone)]
struct DialStdioConnector {
    argv: Arc<Vec<String>>,
}

impl tower_service::Service<hyper::Uri> for DialStdioConnector {
    type Response = TokioIo<BridgeStream>;
    type Error = std::io::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        // Spawning has no readiness precondition.
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, _dst: hyper::Uri) -> Self::Future {
        let argv = Arc::clone(&self.argv);
        Box::pin(async move { spawn_bridge(&argv).map(TokioIo::new) })
    }
}

fn spawn_bridge(argv: &[String]) -> Result<BridgeStream, std::io::Error> {
    let (program, args) = argv.split_first().expect("dial-stdio argv is non-empty");
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // Discarded: the desktop app has no console to inherit, and an unread
        // pipe could block the child. A failing bridge surfaces as the request
        // error instead (spawn failure below, or connection-closed from hyper).
        .stderr(Stdio::null())
        // The bridge must die WITH the connection: hyper drops the pooled
        // stream on close / idle expiry (see the pool timer above — expiry
        // does not run without it), and this reaps the child then.
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — wslc.exe is a console-subsystem binary; spawned
        // from the GUI desktop app without this flag, every pooled connection
        // would flash a console window.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command.spawn().map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!("failed to spawn dial-stdio bridge `{program}`: {e}"),
        )
    })?;
    let stdin = child.stdin.take().expect("stdin was piped");
    let stdout = child.stdout.take().expect("stdout was piped");
    Ok(BridgeStream {
        io: tokio::io::join(stdout, stdin),
        _child: child,
    })
}

/// The child's stdout+stdin joined into one duplex stream, owning the child so
/// the bridge process lives exactly as long as the hyper connection
/// (`kill_on_drop` fires when the pool releases this stream).
struct BridgeStream {
    io: tokio::io::Join<ChildStdout, ChildStdin>,
    _child: Child,
}

impl AsyncRead for BridgeStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl AsyncWrite for BridgeStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.io).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

impl Connection for BridgeStream {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::endpoint::{Endpoint, parse_docker_host};

    /// Pin the exact wslc bridge invocation — it is an EXTERNAL contract
    /// (implementation-reported, see the module doc), so any edit to it must be
    /// deliberate and re-verified on a real Windows machine.
    #[test]
    fn wslc_argv_is_the_reported_invocation() {
        assert_eq!(
            WSLC_DIAL_ARGV.join(" "),
            "wslc system session run docker system dial-stdio"
        );
    }

    /// Spawn failure (bridge binary absent — the "wslc not installed" case)
    /// must surface as a request-time error naming the program, never a panic
    /// or a hang. Construction itself stays lazy and succeeds. Asserted on the
    /// DISPLAY form — that is what `doctor` prints, so the program name must
    /// survive the whole error chain into it.
    #[tokio::test]
    async fn missing_bridge_binary_fails_the_request_with_the_program_name() {
        let docker = connect_dial_stdio(&["compositz-nonexistent-bridge-binary"], 5)
            .expect("construction is lazy — no spawn yet");
        let err = docker.ping().await.expect_err("ping cannot succeed");
        let message = format!("{err}");
        assert!(
            message.contains("compositz-nonexistent-bridge-binary"),
            "error Display should name the missing bridge program: {message}"
        );
    }

    /// The full transport against the REAL engine, through a socat bridge that
    /// is byte-for-byte the same shape as wslc's dial-stdio (stdio ⇄ daemon).
    /// Read-only (ping / version / label-filtered list). Skips without a
    /// configured engine or without socat, so plain `cargo test` stays green.
    #[tokio::test]
    async fn socat_bridge_reaches_the_real_engine() {
        let Some(target) = socat_target() else {
            eprintln!("skip: COMPOSITZ_DOCKER_HOST unset or not tcp/unix");
            return;
        };
        if !socat_available() {
            eprintln!("skip: socat not on PATH");
            return;
        }
        let docker = connect_dial_stdio(&["socat", "STDIO", &target], 30).expect("connect");
        docker.ping().await.expect("ping over dial-stdio bridge");
        let version = docker.version().await.expect("version over bridge");
        assert!(
            version.version.is_some() || version.api_version.is_some(),
            "version response should carry a version"
        );
        // A managed-label-filtered list: read-only, and its response is large
        // enough to exercise chunked reads over the bridge; issuing it after
        // ping/version also proves sequential requests work (pool reuse or a
        // fresh bridge — both must hold).
        let mut filters = std::collections::HashMap::new();
        filters.insert("label".to_string(), vec![crate::brand::label("instance")]);
        let options = bollard::query_parameters::ListContainersOptionsBuilder::new()
            .all(true)
            .filters(&filters)
            .build();
        docker
            .list_containers(Some(options))
            .await
            .expect("label-filtered list over bridge");
    }

    /// A long-lived response over the bridge: subscribe to the daemon's event
    /// stream and hold it open briefly. This catches the "bridge dies after
    /// one exchange" class of bug that request/response calls cannot — an
    /// error item or early stream end within the window fails the test; idle
    /// silence (no events happening) passes. Read-only.
    #[tokio::test]
    async fn event_stream_stays_open_over_the_bridge() {
        use futures_util::StreamExt;
        let Some(target) = socat_target() else {
            eprintln!("skip: COMPOSITZ_DOCKER_HOST unset or not tcp/unix");
            return;
        };
        if !socat_available() {
            eprintln!("skip: socat not on PATH");
            return;
        }
        let docker = connect_dial_stdio(&["socat", "STDIO", &target], 30).expect("connect");
        let mut events = docker.events(Some(
            bollard::query_parameters::EventsOptionsBuilder::new().build(),
        ));
        tokio::select! {
            item = events.next() => match item {
                Some(Ok(_)) => {} // a live event — the stream works
                Some(Err(e)) => panic!("event stream errored over the bridge: {e}"),
                None => panic!("event stream ended prematurely over the bridge"),
            },
            _ = tokio::time::sleep(std::time::Duration::from_millis(1500)) => {
                // Idle but still open — exactly what a healthy subscription
                // looks like on a quiet daemon.
            }
        }
    }

    /// Derive the socat CONNECT target from the same env the production
    /// `connect()` honors, so this test rides the existing integration gate.
    fn socat_target() -> Option<String> {
        let raw = std::env::var(crate::DOCKER_HOST_ENV)
            .ok()
            .filter(|v| !v.is_empty())?;
        match parse_docker_host(&raw).ok()? {
            Endpoint::Tcp { host, port } => Some(format!("TCP:{host}:{port}")),
            Endpoint::Unix { path } => Some(format!("UNIX-CONNECT:{path}")),
            _ => None,
        }
    }

    fn socat_available() -> bool {
        std::process::Command::new("socat")
            .arg("-V")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
    }
}
