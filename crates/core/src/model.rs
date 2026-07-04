//! Wire-facing view types and the pure mapping/formatting helpers, split out so
//! the port-string and event-summary logic can be unit-tested without an engine.

use bollard::models::{ContainerSummary as RawSummary, EventMessage, PortSummary};
use std::collections::HashSet;

/// A container as the CLI/desktop UIs consume it. Field names serialize to
/// camelCase to match the fixed IPC contract with the frontend.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    /// Full container id.
    pub id: String,
    /// Primary name, leading `/` stripped.
    pub name: String,
    /// Lifecycle state, e.g. `running` / `exited`.
    pub state: String,
    /// Image reference.
    pub image: String,
    /// Human-readable published-port strings, e.g. `"8188->8188/tcp"`.
    pub ports: Vec<String>,
}

impl ContainerSummary {
    /// Map a bollard `ContainerSummary` into the view type.
    pub fn from_bollard(raw: RawSummary) -> Self {
        let name = raw
            .names
            .as_ref()
            .and_then(|names| names.first())
            .map(|n| n.trim_start_matches('/').to_string())
            .unwrap_or_default();

        // A dual-stack published port surfaces as two `PortSummary` entries that
        // differ only in `ip` ("0.0.0.0" vs "::") — `format_port` drops the ip, so
        // they render identically ("8188->8188/tcp" twice). Collapse on the
        // (private_port, public_port, proto) identity, preserving first-seen
        // order, so the UI shows one line per logical published port.
        let mut seen: HashSet<(u16, Option<u16>, String)> = HashSet::new();
        let ports = raw
            .ports
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter(|port| seen.insert((port.private_port, port.public_port, port_proto(port))))
            .map(format_port)
            .collect();

        Self {
            id: raw.id.unwrap_or_default(),
            name,
            state: raw.state.map(|s| s.to_string()).unwrap_or_default(),
            image: raw.image.unwrap_or_default(),
            ports,
        }
    }
}

/// Format one [`PortSummary`] as a `docker ps`-style string.
///
/// A published port shows both host and container port: `"8188->8188/tcp"`.
/// An unpublished (container-only) port shows just the private side:
/// `"8188/tcp"`. The protocol defaults to `tcp` when the engine omits it.
fn format_port(port: &PortSummary) -> String {
    let proto = port_proto(port);
    match port.public_port {
        Some(public) => format!("{}->{}/{}", public, port.private_port, proto),
        None => format!("{}/{}", port.private_port, proto),
    }
}

/// The protocol string for a port, defaulting to `tcp` when the engine omits it
/// or reports the empty variant. Shared by [`format_port`], the dual-stack dedup
/// key, and [`crate::view::to_container_statuses`] so they never disagree on what
/// "the same port" means.
pub(crate) fn port_proto(port: &PortSummary) -> String {
    port.typ
        .as_ref()
        .map(|t| t.to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "tcp".to_string())
}

/// Collapse a Docker system event into one compact line, e.g.
/// `container start comfyui-a1b2c3 (image=compositz/...)`.
///
/// The subject is the actor's `name` attribute when present (human-readable),
/// falling back to the short actor id. The trailing `(image=…)` is included only
/// when the actor reports an image attribute.
pub fn summarize_event(event: EventMessage) -> String {
    let typ = event
        .typ
        .as_ref()
        .map(|t| t.to_string())
        .unwrap_or_default();
    let action = event.action.unwrap_or_default();

    let attributes = event.actor.as_ref().and_then(|a| a.attributes.as_ref());
    let subject = attributes
        .and_then(|attrs| attrs.get("name"))
        .cloned()
        .or_else(|| {
            event
                .actor
                .as_ref()
                .and_then(|a| a.id.as_deref())
                .map(short_id)
        })
        .unwrap_or_default();

    let image_suffix = attributes
        .and_then(|attrs| attrs.get("image"))
        .map(|image| format!(" (image={image})"))
        .unwrap_or_default();

    format!("{typ} {action} {subject}{image_suffix}")
        .trim()
        .to_string()
}

/// Shorten a 64-hex container/actor id to its first 12 chars, like docker.
fn short_id(id: &str) -> String {
    id.chars().take(12).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bollard::models::{EventActor, PortSummaryTypeEnum};
    use std::collections::HashMap;

    fn port(private: u16, public: Option<u16>, typ: Option<PortSummaryTypeEnum>) -> PortSummary {
        PortSummary {
            ip: None,
            private_port: private,
            public_port: public,
            typ,
        }
    }

    #[test]
    fn published_port_shows_host_and_container() {
        assert_eq!(
            format_port(&port(8188, Some(8188), Some(PortSummaryTypeEnum::TCP))),
            "8188->8188/tcp"
        );
    }

    #[test]
    fn published_port_with_distinct_host_port() {
        assert_eq!(
            format_port(&port(8080, Some(18080), Some(PortSummaryTypeEnum::TCP))),
            "18080->8080/tcp"
        );
    }

    #[test]
    fn unpublished_port_shows_container_side_only() {
        assert_eq!(
            format_port(&port(9090, None, Some(PortSummaryTypeEnum::TCP))),
            "9090/tcp"
        );
    }

    #[test]
    fn missing_protocol_defaults_to_tcp() {
        assert_eq!(format_port(&port(5000, Some(5000), None)), "5000->5000/tcp");
    }

    #[test]
    fn empty_protocol_defaults_to_tcp() {
        assert_eq!(
            format_port(&port(5000, Some(5000), Some(PortSummaryTypeEnum::EMPTY))),
            "5000->5000/tcp"
        );
    }

    #[test]
    fn udp_protocol_preserved() {
        assert_eq!(
            format_port(&port(53, Some(53), Some(PortSummaryTypeEnum::UDP))),
            "53->53/udp"
        );
    }

    fn event_with(
        typ: Option<bollard::models::EventMessageTypeEnum>,
        action: &str,
        attrs: &[(&str, &str)],
        id: Option<&str>,
    ) -> EventMessage {
        let attributes: HashMap<String, String> = attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        EventMessage {
            typ,
            action: Some(action.to_string()),
            actor: Some(EventActor {
                id: id.map(|s| s.to_string()),
                attributes: Some(attributes),
            }),
            scope: None,
            time: None,
            time_nano: None,
        }
    }

    #[test]
    fn event_summary_uses_name_attribute_and_image() {
        let ev = event_with(
            Some(bollard::models::EventMessageTypeEnum::CONTAINER),
            "start",
            &[
                ("name", "comfyui-a1b2c3"),
                ("image", "compositz/comfyui-a1b2c3"),
            ],
            Some("deadbeefcafe0123456789"),
        );
        assert_eq!(
            summarize_event(ev),
            "container start comfyui-a1b2c3 (image=compositz/comfyui-a1b2c3)"
        );
    }

    #[test]
    fn event_summary_falls_back_to_short_id_without_name() {
        let ev = event_with(
            Some(bollard::models::EventMessageTypeEnum::CONTAINER),
            "die",
            &[],
            Some("deadbeefcafe0123456789"),
        );
        assert_eq!(summarize_event(ev), "container die deadbeefcafe");
    }

    #[test]
    fn dual_stack_ports_are_deduped_by_triple_preserving_order() {
        // A dual-stack published port arrives as two entries differing only in
        // `ip` (IPv4 "0.0.0.0" and IPv6 "::"); they must collapse to one line.
        let ipv4 = PortSummary {
            ip: Some("0.0.0.0".to_string()),
            private_port: 8188,
            public_port: Some(8188),
            typ: Some(PortSummaryTypeEnum::TCP),
        };
        let ipv6 = PortSummary {
            ip: Some("::".to_string()),
            private_port: 8188,
            public_port: Some(8188),
            typ: Some(PortSummaryTypeEnum::TCP),
        };
        // A genuinely distinct port (different container port) must survive.
        let other = port(9090, Some(19090), Some(PortSummaryTypeEnum::TCP));
        let raw = RawSummary {
            id: Some("abc123".to_string()),
            names: Some(vec!["/compositz-comfyui".to_string()]),
            image: Some("compositz/comfyui:0.1.0".to_string()),
            state: Some(bollard::models::ContainerSummaryStateEnum::RUNNING),
            ports: Some(vec![ipv4, ipv6, other]),
            ..Default::default()
        };
        let summary = ContainerSummary::from_bollard(raw);
        assert_eq!(
            summary.ports,
            vec!["8188->8188/tcp".to_string(), "19090->9090/tcp".to_string()]
        );
    }

    #[test]
    fn container_summary_strips_leading_slash_from_name() {
        let raw = RawSummary {
            id: Some("abc123".to_string()),
            names: Some(vec!["/compositz-comfyui".to_string()]),
            image: Some("compositz/comfyui:0.1.0".to_string()),
            state: Some(bollard::models::ContainerSummaryStateEnum::RUNNING),
            ports: Some(vec![port(8188, Some(8188), Some(PortSummaryTypeEnum::TCP))]),
            ..Default::default()
        };
        let summary = ContainerSummary::from_bollard(raw);
        assert_eq!(summary.name, "compositz-comfyui");
        assert_eq!(summary.state, "running");
        assert_eq!(summary.ports, vec!["8188->8188/tcp".to_string()]);
    }
}
