//! The per-instance launch override (`config.yaml`): the user's customizations
//! layered over the manifest's author defaults (ADR-014, RI-4). It carries ONLY
//! values — host-port remaps, env values, and per-mount placement — each keyed by
//! the manifest `name`. The manifest is never mutated; at `up` the effective spec
//! is derived from manifest ⊕ override (see `run.rs`).
//!
//! `dataRoot` is intentionally NOT part of the persisted override — it is a
//! global install concern.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::Error;
use crate::recipe::manifest::Placement;

/// The persisted per-instance override — a strict subset of `run.rs`'s launch config.
/// Crosses the IPC boundary as the `set_config` INPUT, so it is a `specta::Type`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Override {
    /// Host-port remap, keyed by port `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_ports: Option<BTreeMap<String, u32>>,
    /// Env value override, keyed by env `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    /// Placement override, keyed by mount `name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement: Option<BTreeMap<String, Placement>>,
}

/// Parse + validate an override from `config.yaml` text. An empty / blank / `null`
/// document is a valid empty override (the common case). Returns [`Error::Config`]
/// on any problem.
pub fn parse_override(yaml_text: &str) -> Result<Override, Error> {
    // An empty or whitespace-only file has no YAML node to deserialize; treat it
    // as the empty override before handing anything to serde.
    if yaml_text.trim().is_empty() {
        return Ok(Override::default());
    }
    let value: serde_norway::Value = serde_norway::from_str(yaml_text)
        .map_err(|e| Error::Config(format!("config is not valid YAML: {e}")))?;
    // `null` (e.g. a file of just `~`) is likewise the empty override.
    if value.is_null() {
        return Ok(Override::default());
    }
    let overrides: Override = serde_norway::from_value(value)
        .map_err(|e| Error::Config(format!("config is not valid: {e}")))?;
    validate(&overrides)?;
    Ok(overrides)
}

/// Serialize an override to `config.yaml` text, dropping empty sections for a
/// clean file.
pub fn serialize_override(overrides: &Override) -> Result<String, Error> {
    serde_norway::to_string(&normalize(overrides))
        .map_err(|e| Error::Config(format!("config failed to serialize: {e}")))
}

/// Structural equality of two overrides — ignores key order and empty-vs-absent
/// sections (used to tell whether a restart is needed to apply edited settings).
pub fn same_override(a: &Override, b: &Override) -> bool {
    normalize(a) == normalize(b)
}

/// Validate an override's values (the host-port range check) — for the desktop
/// `set_config` path, where the override arrives already-deserialized (serde) and so
/// bypasses [`parse_override`]'s validation. Env/placement are checked structurally
/// by serde; this adds the only value constraint parse enforces.
pub fn validate_override(overrides: &Override) -> Result<(), Error> {
    validate(overrides)
}

/// Reject host ports outside the valid range (the only value constraint; env and
/// placement are fully checked structurally by serde).
fn validate(overrides: &Override) -> Result<(), Error> {
    if let Some(ports) = &overrides.host_ports {
        for (name, &port) in ports {
            if !(1..=65535).contains(&port) {
                return Err(Error::Config(format!(
                    "config.hostPorts.{name} must be an integer between 1 and 65535"
                )));
            }
        }
    }
    Ok(())
}

/// Collapse empty sections to absent, so `{env: {}}` and `{}` compare and
/// serialize identically.
fn normalize(overrides: &Override) -> Override {
    Override {
        host_ports: non_empty(&overrides.host_ports),
        env: non_empty(&overrides.env),
        placement: non_empty(&overrides.placement),
    }
}

fn non_empty<V: Clone>(section: &Option<BTreeMap<String, V>>) -> Option<BTreeMap<String, V>> {
    match section {
        Some(map) if !map.is_empty() => Some(map.clone()),
        _ => None,
    }
}
