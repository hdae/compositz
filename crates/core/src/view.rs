//! Pure view-model derivation for the desktop dashboard.
//!
//! The Rust backend derives every view-model and hands the finished, typed shape
//! to the React UI over IPC — so this logic lives in `core` (locally testable)
//! rather than the desktop crate. The types serialize `camelCase` to match the
//! frontend contract and (under the `specta` feature) generate the TS types via
//! `tauri-specta`, so there is exactly ONE definition of each shape.
//!
//! Everything here is a pure function of its inputs; the engine / store / probe I/O
//! that feeds them lives in the snapshot assembly (`probe` module) and the desktop
//! command handlers.

use crate::model::port_proto;
use crate::recipe::config::Override;
use crate::recipe::instance::Instance;
use crate::recipe::manifest::Placement;
use crate::recipe::run::{effective_host_port, instance_image_tag};
use bollard::models::ContainerSummary as RawContainerSummary;
use serde::Serialize;

/// A manifest port that serves a browser UI (`web: true`). An app may declare many.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct WebPort {
    /// Stable port name (label + override key).
    pub name: String,
    /// Port inside the container — joined to a running container's published port.
    pub container: u32,
    pub protocol: String,
    /// Absolute UI path appended to the URL.
    pub path: String,
    /// Effective DEFINED host port (override ▷ manifest host ▷ container) — the
    /// fallback when no live published port is known yet.
    pub host: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A container port that the engine has actually published to the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PublishedPort {
    pub container: u32,
    pub public: u32,
    pub protocol: String,
    /// The app behind the port ACCEPTS an HTTP request (server-side probe). Docker
    /// publishes the mapping the moment the container starts — minutes before a
    /// heavy AI app listens — so `ready` requires an explicit `Some(true)` (a
    /// missing probe degrades to "starting…", never to a false "ready").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accepting: Option<bool>,
}

/// A declared web endpoint resolved to a host port (live published ▷ defined), with
/// `ready` gated on the probe.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Host port: live published ▷ defined (override ▷ manifest).
    pub port: u32,
    /// Openable URL built from `port` + path.
    pub url: String,
    /// The live binding is confirmed in `ps` AND the app answered the probe.
    pub ready: bool,
}

/// An instance reduced to the fields the dashboard renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct InstanceView {
    /// The runtime key — actions and status match on this.
    pub instance_id: String,
    /// The app (manifest id) this instance runs — a slug, for display/grouping.
    pub app_id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    /// Declared web ports (`web: true`). Live URLs are resolved against the container.
    pub web_ports: Vec<WebPort>,
    /// The image tag this instance builds to (e.g. `compositz/hello-a1b2c3:0.1.0`).
    pub image_tag: String,
}

/// A managed container reduced to what the dashboard needs — `instance` is the
/// instance id carried by the container label (`None` if absent); `state` is
/// Docker's container state; `ports` are the host-published bindings.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ContainerStatus {
    pub instance: Option<String>,
    pub state: String,
    pub ports: Vec<PublishedPort>,
}

/// A live read of the engine: managed containers + which image tags exist locally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct EngineSnapshot {
    pub containers: Vec<ContainerStatus>,
    /// Image tags that exist locally.
    pub installed_tags: Vec<String>,
}

/// One rendered dashboard row: an instance plus its derived runtime status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct InstanceRow {
    pub instance_id: String,
    pub app_id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub web_ports: Vec<WebPort>,
    /// Declared services, always listed from the definition; the live port fills in
    /// when running.
    pub services: Vec<Service>,
    /// Image built locally? `None` when the engine is unreachable (unknown).
    pub installed: Option<bool>,
    /// A managed container for this instance is in the "running" state.
    pub running: bool,
}

// --- per-instance settings (RI-4 override editor) --------------------------

/// One manifest port in the Settings editor: author default + saved override.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PortSetting {
    pub name: String,
    pub container: u32,
    pub web: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Manifest default host port (`p.host ?? p.container`).
    pub manifest_host: u32,
    /// Saved host-port override, if any.
    #[serde(rename = "override", skip_serializing_if = "Option::is_none")]
    pub over: Option<u32>,
}

/// One manifest env var in the Settings editor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct EnvSetting {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub required: bool,
    /// Manifest default / placeholder value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
    /// Saved value override, if any.
    #[serde(rename = "override", skip_serializing_if = "Option::is_none")]
    pub over: Option<String>,
}

/// One manifest mount in the Settings editor (placement is the only override).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct MountSetting {
    pub name: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub manifest_placement: Placement,
    #[serde(rename = "override", skip_serializing_if = "Option::is_none")]
    pub over: Option<Placement>,
}

/// The Settings editor view-model for one instance (manifest ⊕ saved override).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct InstanceSettings {
    pub ports: Vec<PortSetting>,
    pub env: Vec<EnvSetting>,
    pub mounts: Vec<MountSetting>,
    /// Host ports DEFINED by OTHER instances — the client checks port conflicts
    /// against this (definition-based, so it catches stopped instances).
    pub taken_by_others: Vec<u32>,
    /// The saved config has diverged from what the running instance was launched with.
    pub restart_needed: bool,
}

/// Map raw engine container summaries to the slim [`ContainerStatus`] shape, keeping
/// only host-published ports (those carry a `public_port`). `accepting` is left
/// `None` — the probe step fills it for the running web ports.
///
/// `instance_label_key` is the container label that carries an instance id
/// (e.g. `io.compositz.instance`).
pub fn to_container_statuses(
    summaries: &[RawContainerSummary],
    instance_label_key: &str,
) -> Vec<ContainerStatus> {
    summaries
        .iter()
        .map(|c| ContainerStatus {
            instance: c
                .labels
                .as_ref()
                .and_then(|labels| labels.get(instance_label_key))
                .cloned(),
            state: c.state.as_ref().map(|s| s.to_string()).unwrap_or_default(),
            ports: c
                .ports
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter_map(|p| {
                    p.public_port.map(|public| PublishedPort {
                        container: u32::from(p.private_port),
                        public: u32::from(public),
                        protocol: port_proto(p),
                        accepting: None,
                    })
                })
                .collect(),
        })
        .collect()
}

/// List EVERY declared web port, resolving each host port by precedence:
/// **live published ▷ defined (override ▷ manifest)**. The live port wins when known
/// because it is what the container is ACTUALLY on (covering an unrestarted override
/// change and an engine auto-bump). With no live binding yet, fall back to the
/// defined port (`wp.host`) so the row shows the *expected* endpoint, `ready: false`.
fn instance_services(web_ports: &[WebPort], ports: &[PublishedPort]) -> Vec<Service> {
    web_ports
        .iter()
        .map(|wp| {
            let live = ports
                .iter()
                .find(|p| p.container == wp.container && p.protocol == wp.protocol);
            let port = live.map(|p| p.public).unwrap_or(wp.host);
            Service {
                name: wp.name.clone(),
                path: wp.path.clone(),
                description: wp.description.clone(),
                port,
                url: format!("http://localhost:{port}{}", wp.path),
                // Ready = published AND the app answers the probe. A live binding
                // alone appears at container start, long before a heavy app listens.
                ready: live.is_some_and(|p| p.accepting == Some(true)),
            }
        })
        .collect()
}

/// Build the dashboard view-model for a loaded / freshly-ingested instance. `over` is
/// the per-instance override (`config.yaml`) — each web port carries its effective
/// DEFINED host port (override ▷ manifest), the fallback the Services list uses before
/// a live port is known. Pure: the caller loads the override
/// ([`crate::load_instance_config`]).
pub fn to_instance_view(instance: &Instance, over: &Override) -> InstanceView {
    let m = &instance.manifest;
    let host_ports = over.host_ports.clone().unwrap_or_default();
    InstanceView {
        instance_id: instance.instance_id.clone(),
        app_id: instance.app_id.clone(),
        // Per-instance display name (a duplicate's "<name> (copy)") ▷ manifest brand.
        name: instance.display_name().to_string(),
        version: m.version.clone(),
        description: m.description.clone().unwrap_or_default(),
        web_ports: m
            .ports
            .iter()
            .filter(|p| p.web)
            .map(|p| WebPort {
                name: p.name.clone(),
                container: p.container,
                protocol: p.protocol.as_str().to_string(),
                path: p.path.clone(),
                host: effective_host_port(p, &host_ports),
                description: p.description.clone(),
            })
            .collect(),
        image_tag: instance_image_tag(m, &instance.instance_id),
    }
}

/// Derive dashboard rows from instance views and an optional engine snapshot.
///
/// Services are ALWAYS listed from the definition (manifest ⊕ override) — so a
/// recipe's web endpoints show before it starts. The live published port fills in
/// (and the service becomes openable) once a running container publishes it. When
/// `snapshot` is `None` the engine was unreachable: `installed` is unknown (`None`),
/// nothing is running.
pub fn to_instance_rows(
    views: &[InstanceView],
    snapshot: Option<&EngineSnapshot>,
) -> Vec<InstanceRow> {
    views
        .iter()
        .map(|v| {
            let (installed, running, live_ports): (Option<bool>, bool, &[PublishedPort]) =
                match snapshot {
                    None => (None, false, &[]),
                    Some(snap) => {
                        let container = snap.containers.iter().find(|c| {
                            c.instance.as_deref() == Some(v.instance_id.as_str())
                                && c.state == "running"
                        });
                        (
                            Some(snap.installed_tags.iter().any(|t| t == &v.image_tag)),
                            container.is_some(),
                            container.map(|c| c.ports.as_slice()).unwrap_or(&[]),
                        )
                    }
                };
            InstanceRow {
                instance_id: v.instance_id.clone(),
                app_id: v.app_id.clone(),
                name: v.name.clone(),
                version: v.version.clone(),
                description: v.description.clone(),
                web_ports: v.web_ports.clone(),
                services: instance_services(&v.web_ports, live_ports),
                installed,
                running,
            }
        })
        .collect()
}

/// Build the Settings editor view-model: each manifest port/env/mount with its author
/// default and the saved override. Pure — the caller supplies `taken_by_others`
/// ([`crate::defined_host_ports`] for the OTHER instances) and `restart_needed` (the
/// saved config diverged from what a running instance was launched with).
pub fn build_settings(
    instance: &Instance,
    over: &Override,
    taken_by_others: Vec<u32>,
    restart_needed: bool,
) -> InstanceSettings {
    let m = &instance.manifest;
    let host_ports = over.host_ports.as_ref();
    let env = over.env.as_ref();
    let placement = over.placement.as_ref();
    InstanceSettings {
        ports: m
            .ports
            .iter()
            .map(|p| PortSetting {
                name: p.name.clone(),
                container: p.container,
                web: p.web,
                description: p.description.clone(),
                manifest_host: p.host.unwrap_or(p.container),
                over: host_ports.and_then(|h| h.get(&p.name).copied()),
            })
            .collect(),
        env: m
            .env
            .iter()
            .map(|e| EnvSetting {
                name: e.name.clone(),
                description: e.description.clone(),
                required: e.required,
                default: e.default.clone(),
                over: env.and_then(|h| h.get(&e.name).cloned()),
            })
            .collect(),
        mounts: m
            .mounts
            .iter()
            .map(|mt| MountSetting {
                name: mt.name.clone(),
                target: mt.target.clone(),
                description: mt.description.clone(),
                manifest_placement: mt.placement,
                over: placement.and_then(|h| h.get(&mt.name).copied()),
            })
            .collect(),
        taken_by_others,
        restart_needed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::recipe::instance::{Instance, InstanceMeta};
    use crate::recipe::manifest::{
        BuildSpec, EnvSpec, Manifest, MountMapping, PortMapping, Protocol,
    };
    use std::collections::BTreeMap;

    const IID: &str = "hello-web-a1b2c3";

    fn web_port() -> WebPort {
        WebPort {
            name: "web".to_string(),
            container: 8080,
            protocol: "tcp".to_string(),
            path: "/".to_string(),
            host: 8090,
            description: None,
        }
    }

    fn view() -> InstanceView {
        InstanceView {
            instance_id: IID.to_string(),
            app_id: "hello-web".to_string(),
            name: "Hello Web".to_string(),
            version: "0.1.0".to_string(),
            description: "demo".to_string(),
            web_ports: vec![web_port()],
            image_tag: "compositz/hello-web-a1b2c3:0.1.0".to_string(),
        }
    }

    fn status(instance: Option<&str>, state: &str, ports: Vec<PublishedPort>) -> ContainerStatus {
        ContainerStatus {
            instance: instance.map(str::to_string),
            state: state.to_string(),
            ports,
        }
    }

    fn snapshot(containers: Vec<ContainerStatus>, installed: &[&str]) -> EngineSnapshot {
        EngineSnapshot {
            containers,
            installed_tags: installed.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn published(container: u32, public: u32, accepting: Option<bool>) -> PublishedPort {
        PublishedPort {
            container,
            public,
            protocol: "tcp".to_string(),
            accepting,
        }
    }

    // --- toInstanceRows / offline -----------------------------------------

    #[test]
    fn engine_offline_null_snapshot_lists_instances_installed_unknown_not_running() {
        let rows = to_instance_rows(&[view()], None);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].installed, None);
        assert!(!rows[0].running);
        assert_eq!(
            rows[0].services,
            vec![Service {
                name: "web".to_string(),
                path: "/".to_string(),
                description: None,
                port: 8090,
                url: "http://localhost:8090/".to_string(),
                ready: false,
            }]
        );
        assert_eq!(rows[0].name, "Hello Web");
    }

    #[test]
    fn a_running_managed_container_marks_the_row_running() {
        let snap = snapshot(vec![status(Some(IID), "running", vec![])], &[]);
        assert!(to_instance_rows(&[view()], Some(&snap))[0].running);
    }

    #[test]
    fn a_stopped_container_does_not_mark_the_row_running() {
        let snap = snapshot(vec![status(Some(IID), "exited", vec![])], &[]);
        assert!(!to_instance_rows(&[view()], Some(&snap))[0].running);
    }

    #[test]
    fn a_running_container_for_a_different_instance_does_not_bleed_across_rows() {
        let snap = snapshot(
            vec![status(Some("something-else-x9y8z7"), "running", vec![])],
            &[],
        );
        assert!(!to_instance_rows(&[view()], Some(&snap))[0].running);
    }

    #[test]
    fn installed_reflects_whether_the_instances_image_tag_exists_locally() {
        let present = snapshot(vec![], &["compositz/hello-web-a1b2c3:0.1.0"]);
        assert_eq!(
            to_instance_rows(&[view()], Some(&present))[0].installed,
            Some(true)
        );
        let absent = snapshot(vec![], &["compositz/other:1.0.0"]);
        assert_eq!(
            to_instance_rows(&[view()], Some(&absent))[0].installed,
            Some(false)
        );
    }

    #[test]
    fn no_instances_yields_no_rows() {
        assert_eq!(to_instance_rows(&[], Some(&snapshot(vec![], &[]))), vec![]);
    }

    // --- instanceServices --------------------------------------------------

    #[test]
    fn instance_services_a_live_published_port_wins_over_the_defined_port() {
        let web_ports = vec![WebPort {
            name: "ui".to_string(),
            container: 8080,
            protocol: "tcp".to_string(),
            path: "/app".to_string(),
            host: 8080,
            description: None,
        }];
        let ports = vec![published(8080, 49153, Some(true))];
        assert_eq!(
            instance_services(&web_ports, &ports),
            vec![Service {
                name: "ui".to_string(),
                path: "/app".to_string(),
                description: None,
                port: 49153,
                url: "http://localhost:49153/app".to_string(),
                ready: true,
            }]
        );
    }

    #[test]
    fn instance_services_a_published_port_not_yet_accepting_shows_live_but_stays_not_ready() {
        // Docker publishes at container start, long before a heavy app listens
        // ("warming") — the live port wins for DISPLAY, but ready needs the probe.
        let ports = vec![published(8080, 18080, Some(false))];
        assert_eq!(
            instance_services(&[web_port()], &ports),
            vec![Service {
                name: "web".to_string(),
                path: "/".to_string(),
                description: None,
                port: 18080,
                url: "http://localhost:18080/".to_string(),
                ready: false,
            }]
        );
        // An UNPROBED binding (accepting: None) degrades the same way — never "ready".
        assert!(!instance_services(&[web_port()], &[published(8080, 18080, None)])[0].ready);
    }

    #[test]
    fn instance_services_with_no_live_binding_falls_back_to_the_defined_port() {
        assert_eq!(
            instance_services(&[web_port()], &[]),
            vec![Service {
                name: "web".to_string(),
                path: "/".to_string(),
                description: None,
                port: 8090,
                url: "http://localhost:8090/".to_string(),
                ready: false,
            }]
        );
        // Protocol mismatch is not a live binding → still the defined port, not ready.
        let udp = PublishedPort {
            container: 8080,
            public: 5000,
            protocol: "udp".to_string(),
            accepting: None,
        };
        let out = instance_services(&[web_port()], &[udp]);
        assert_eq!(out[0].port, 8090);
        assert!(!out[0].ready);
    }

    #[test]
    fn instance_services_lists_every_declared_web_port() {
        let web_ports = vec![
            WebPort {
                name: "ui".to_string(),
                container: 8080,
                protocol: "tcp".to_string(),
                path: "/".to_string(),
                host: 8080,
                description: None,
            },
            WebPort {
                name: "admin".to_string(),
                container: 9090,
                protocol: "tcp".to_string(),
                path: "/admin".to_string(),
                host: 9090,
                description: None,
            },
        ];
        // admin (9090) not published yet → falls back to its defined host 9090.
        let ports = vec![published(8080, 18080, Some(true))];
        let out: Vec<(String, bool)> = instance_services(&web_ports, &ports)
            .into_iter()
            .map(|s| (s.url, s.ready))
            .collect();
        assert_eq!(
            out,
            vec![
                ("http://localhost:18080/".to_string(), true),
                ("http://localhost:9090/admin".to_string(), false),
            ]
        );
    }

    #[test]
    fn to_instance_rows_resolves_services_from_the_running_containers_live_ports() {
        // Declared host 8090; the running container published on a bumped 18080 —
        // live wins.
        let running = status(
            Some(IID),
            "running",
            vec![published(8080, 18080, Some(true))],
        );
        let snap = snapshot(vec![running], &[]);
        assert_eq!(
            to_instance_rows(&[view()], Some(&snap))[0].services,
            vec![Service {
                name: "web".to_string(),
                path: "/".to_string(),
                description: None,
                port: 18080,
                url: "http://localhost:18080/".to_string(),
                ready: true,
            }]
        );
    }

    #[test]
    fn to_instance_rows_shows_the_defined_port_before_the_live_binding_appears() {
        // Running, but the snapshot hasn't carried the published port yet.
        let starting_up = status(Some(IID), "running", vec![]);
        let snap = snapshot(vec![starting_up], &[]);
        assert_eq!(
            to_instance_rows(&[view()], Some(&snap))[0].services,
            vec![Service {
                name: "web".to_string(),
                path: "/".to_string(),
                description: None,
                port: 8090,
                url: "http://localhost:8090/".to_string(),
                ready: false,
            }]
        );
    }

    #[test]
    fn to_instance_rows_a_stopped_instance_still_lists_services_from_the_definition() {
        let stopped = status(Some(IID), "exited", vec![]);
        let snap = snapshot(vec![stopped], &[]);
        assert_eq!(
            to_instance_rows(&[view()], Some(&snap))[0].services,
            vec![Service {
                name: "web".to_string(),
                path: "/".to_string(),
                description: None,
                port: 8090,
                url: "http://localhost:8090/".to_string(),
                ready: false,
            }]
        );
    }

    // --- toContainerStatuses (bollard-facing) -----------------------------

    #[test]
    fn to_container_statuses_maps_label_state_and_host_published_ports() {
        use bollard::models::{
            ContainerSummary as Raw, ContainerSummaryStateEnum, PortSummary, PortSummaryTypeEnum,
        };
        use std::collections::HashMap;

        let instance_label = "io.compositz.instance";
        let mut labels = HashMap::new();
        labels.insert(instance_label.to_string(), IID.to_string());
        let running = Raw {
            state: Some(ContainerSummaryStateEnum::RUNNING),
            labels: Some(labels),
            ports: Some(vec![
                PortSummary {
                    ip: None,
                    private_port: 8080,
                    public_port: Some(18080),
                    typ: Some(PortSummaryTypeEnum::TCP),
                },
                // unpublished → dropped
                PortSummary {
                    ip: None,
                    private_port: 9090,
                    public_port: None,
                    typ: Some(PortSummaryTypeEnum::TCP),
                },
            ]),
            ..Default::default()
        };
        let exited = Raw {
            state: Some(ContainerSummaryStateEnum::EXITED),
            labels: Some(HashMap::new()),
            ports: Some(vec![]),
            ..Default::default()
        };
        let out = to_container_statuses(&[running, exited], instance_label);
        assert_eq!(
            out,
            vec![
                status(Some(IID), "running", vec![published(8080, 18080, None)]),
                status(None, "exited", vec![]),
            ]
        );
    }

    // --- toInstanceView (ported from instance-view_test.ts) ---------------

    fn base_manifest() -> Manifest {
        Manifest {
            manifest_version: 2,
            id: "hello".to_string(),
            name: "Hello".to_string(),
            version: "0.1.0".to_string(),
            description: Some("A hello app.".to_string()),
            build: Some(BuildSpec {
                dockerfile: "Dockerfile".to_string(),
                args: None,
            }),
            image: None,
            ports: vec![],
            mounts: vec![],
            cache: vec![],
            env: vec![],
            gpu: Default::default(),
        }
    }

    fn instance_with(manifest: Manifest) -> Instance {
        Instance {
            instance_id: "hello-a1b2c3d4".to_string(),
            app_id: manifest.id.clone(),
            dir: "/store/hello-a1b2c3d4".to_string(),
            manifest,
            context: vec![],
            meta: InstanceMeta {
                source: Some("github:owner/repo".to_string()),
                created_at: Some("2026-01-01T00:00:00Z".to_string()),
                name: None,
            },
        }
    }

    fn port(
        name: &str,
        container: u32,
        host: Option<u32>,
        web: bool,
        path: &str,
        desc: Option<&str>,
    ) -> PortMapping {
        PortMapping {
            name: name.to_string(),
            container,
            host,
            protocol: Protocol::Tcp,
            web,
            path: path.to_string(),
            description: desc.map(str::to_string),
        }
    }

    #[test]
    fn to_instance_view_maps_identity_name_version_description() {
        let v = to_instance_view(&instance_with(base_manifest()), &Override::default());
        assert_eq!(v.instance_id, "hello-a1b2c3d4");
        assert_eq!(v.app_id, "hello");
        assert_eq!(v.name, "Hello");
        assert_eq!(v.version, "0.1.0");
        assert_eq!(v.description, "A hello app.");
    }

    #[test]
    fn to_instance_view_a_missing_description_becomes_an_empty_string() {
        let mut m = base_manifest();
        m.description = None;
        let v = to_instance_view(&instance_with(m), &Override::default());
        assert_eq!(v.description, "");
    }

    #[test]
    fn to_instance_view_prefers_the_per_instance_name_over_the_manifest_brand() {
        // No override ⇒ the manifest brand name.
        let mut instance = instance_with(base_manifest());
        assert_eq!(
            to_instance_view(&instance, &Override::default()).name,
            "Hello"
        );
        // A per-instance name (a duplicate's "<name> (copy)") takes precedence.
        instance.meta.name = Some("Hello (copy)".to_string());
        assert_eq!(
            to_instance_view(&instance, &Override::default()).name,
            "Hello (copy)"
        );
    }

    #[test]
    fn to_instance_view_web_ports_includes_only_web_true_ports_with_view_fields() {
        let mut m = base_manifest();
        m.ports = vec![
            port("ui", 8188, Some(8188), true, "/", Some("Web UI.")),
            port("api", 9000, None, false, "/", None),
            port("alt", 8189, None, true, "/admin", None),
        ];
        let v = to_instance_view(&instance_with(m), &Override::default());
        assert_eq!(
            v.web_ports,
            vec![
                WebPort {
                    name: "ui".to_string(),
                    container: 8188,
                    protocol: "tcp".to_string(),
                    path: "/".to_string(),
                    host: 8188,
                    description: Some("Web UI.".to_string()),
                },
                // alt has no manifest host → falls back to its container port 8189.
                WebPort {
                    name: "alt".to_string(),
                    container: 8189,
                    protocol: "tcp".to_string(),
                    path: "/admin".to_string(),
                    host: 8189,
                    description: None,
                },
            ]
        );
    }

    #[test]
    fn to_instance_view_image_tag_for_a_build_recipe_carries_instance_id_and_version() {
        let v = to_instance_view(&instance_with(base_manifest()), &Override::default());
        assert!(v.image_tag.contains("hello-a1b2c3d4"));
        assert!(v.image_tag.contains("0.1.0"));
    }

    #[test]
    fn to_instance_view_an_image_based_recipe_uses_the_external_image_as_the_tag() {
        let mut m = base_manifest();
        m.build = None;
        m.image = Some("ollama/ollama:0.6.0".to_string());
        let v = to_instance_view(&instance_with(m), &Override::default());
        assert_eq!(v.image_tag, "ollama/ollama:0.6.0");
    }

    // --- buildSettings ----------

    #[test]
    fn build_settings_maps_each_manifest_item_with_its_saved_override() {
        let mut m = base_manifest();
        m.ports = vec![port("ui", 8188, Some(8000), true, "/", Some("UI"))];
        m.env = vec![EnvSpec {
            name: "TOKEN".to_string(),
            description: Some("api token".to_string()),
            required: true,
            default: Some("changeme".to_string()),
        }];
        m.mounts = vec![MountMapping {
            name: "data".to_string(),
            target: "/data".to_string(),
            placement: Placement::Volume,
            description: Some("state".to_string()),
        }];

        let mut host_ports = BTreeMap::new();
        host_ports.insert("ui".to_string(), 9999_u32);
        let mut env = BTreeMap::new();
        env.insert("TOKEN".to_string(), "secret".to_string());
        let mut placement = BTreeMap::new();
        placement.insert("data".to_string(), Placement::Bind);
        let over = Override {
            host_ports: Some(host_ports),
            env: Some(env),
            placement: Some(placement),
        };

        let s = build_settings(&instance_with(m), &over, vec![8000, 8001], true);
        assert_eq!(
            s.ports,
            vec![PortSetting {
                name: "ui".to_string(),
                container: 8188,
                web: true,
                description: Some("UI".to_string()),
                manifest_host: 8000,
                over: Some(9999),
            }]
        );
        assert_eq!(
            s.env,
            vec![EnvSetting {
                name: "TOKEN".to_string(),
                description: Some("api token".to_string()),
                required: true,
                default: Some("changeme".to_string()),
                over: Some("secret".to_string()),
            }]
        );
        assert_eq!(
            s.mounts,
            vec![MountSetting {
                name: "data".to_string(),
                target: "/data".to_string(),
                description: Some("state".to_string()),
                manifest_placement: Placement::Volume,
                over: Some(Placement::Bind),
            }]
        );
        assert_eq!(s.taken_by_others, vec![8000, 8001]);
        assert!(s.restart_needed);
    }

    #[test]
    fn build_settings_manifest_host_defaults_to_container_when_unset_and_no_override() {
        let mut m = base_manifest();
        m.ports = vec![port("ui", 8188, None, false, "/", None)];
        let s = build_settings(&instance_with(m), &Override::default(), vec![], false);
        assert_eq!(s.ports[0].manifest_host, 8188);
        assert_eq!(s.ports[0].over, None);
        assert!(!s.restart_needed);
    }
}
