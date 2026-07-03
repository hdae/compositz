//! Behavior tests for the per-instance override parser, ported from
//! `packages/core/src/recipe/config_test.ts`.

use std::collections::BTreeMap;

use compositz_core::recipe::config::{Override, parse_override, same_override, serialize_override};
use compositz_core::recipe::manifest::Placement;

fn map<V: Clone>(pairs: &[(&str, V)]) -> BTreeMap<String, V> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.clone()))
        .collect()
}

// --- parse_override --------------------------------------------------------

#[test]
fn parse_override_full_keys_by_name() {
    let yaml = "hostPorts:\n  ui: 8189\nenv:\n  HF_TOKEN: secret\nplacement:\n  output: bind\n";
    assert_eq!(
        parse_override(yaml).unwrap(),
        Override {
            host_ports: Some(map(&[("ui", 8189u32)])),
            env: Some(map(&[("HF_TOKEN", "secret".to_string())])),
            placement: Some(map(&[("output", Placement::Bind)])),
        }
    );
}

#[test]
fn parse_override_empty_or_blank_is_empty() {
    assert_eq!(parse_override("").unwrap(), Override::default());
    assert_eq!(parse_override("\n").unwrap(), Override::default());
    assert_eq!(parse_override("{}\n").unwrap(), Override::default());
}

#[test]
fn parse_override_partial_keeps_only_present_sections() {
    assert_eq!(
        parse_override("hostPorts: { ui: 9000 }\n").unwrap(),
        Override {
            host_ports: Some(map(&[("ui", 9000u32)])),
            env: None,
            placement: None,
        }
    );
}

#[test]
fn parse_override_rejects_out_of_range_or_non_integer_host_port() {
    assert!(parse_override("hostPorts: { ui: 70000 }\n").is_err());
    assert!(parse_override("hostPorts: { ui: 0 }\n").is_err());
    assert!(parse_override("hostPorts: { ui: 80.5 }\n").is_err());
}

#[test]
fn parse_override_rejects_invalid_placement() {
    assert!(parse_override("placement: { output: tmpfs }\n").is_err());
}

#[test]
fn parse_override_rejects_unknown_top_level_key() {
    assert!(parse_override("hostPort: { ui: 8189 }\n").is_err()); // singular typo
    assert!(parse_override("dataRoot: /tmp/x\n").is_err()); // deferred, not persisted
}

#[test]
fn parse_override_rejects_non_string_env_value() {
    assert!(parse_override("env:\n  HF_TOKEN: [1, 2]\n").is_err());
}

// --- serialize_override ----------------------------------------------------

#[test]
fn serialize_override_round_trips_through_parse() {
    let overrides = Override {
        host_ports: Some(map(&[("ui", 8189u32), ("api", 9001u32)])),
        env: Some(map(&[("HF_TOKEN", "x".to_string())])),
        placement: Some(map(&[("output", Placement::Bind)])),
    };
    let text = serialize_override(&overrides).unwrap();
    assert_eq!(parse_override(&text).unwrap(), overrides);
}

#[test]
fn serialize_override_drops_empty_sections() {
    let all_empty = Override {
        host_ports: Some(BTreeMap::new()),
        env: Some(BTreeMap::new()),
        placement: Some(BTreeMap::new()),
    };
    assert_eq!(
        parse_override(&serialize_override(&all_empty).unwrap()).unwrap(),
        Override::default()
    );
    assert_eq!(
        serialize_override(&Override::default()).unwrap(),
        serialize_override(&Override {
            host_ports: Some(BTreeMap::new()),
            ..Override::default()
        })
        .unwrap()
    );
}

// --- same_override (restart-needed comparison) -----------------------------

#[test]
fn same_override_ignores_key_order_and_empty_vs_absent() {
    assert!(same_override(
        &Override {
            host_ports: Some(map(&[("a", 1u32), ("b", 2u32)])),
            ..Override::default()
        },
        &Override {
            host_ports: Some(map(&[("b", 2u32), ("a", 1u32)])),
            ..Override::default()
        },
    ));
    assert!(same_override(
        &Override::default(),
        &Override {
            host_ports: Some(BTreeMap::new()),
            env: Some(BTreeMap::new()),
            placement: Some(BTreeMap::new()),
        },
    ));
}

#[test]
fn same_override_differing_value_key_or_section_is_not_equal() {
    assert!(!same_override(
        &Override {
            host_ports: Some(map(&[("ui", 8189u32)])),
            ..Override::default()
        },
        &Override {
            host_ports: Some(map(&[("ui", 8190u32)])),
            ..Override::default()
        },
    ));
    assert!(!same_override(
        &Override {
            host_ports: Some(map(&[("ui", 8189u32)])),
            ..Override::default()
        },
        &Override {
            host_ports: Some(map(&[("web", 8189u32)])),
            ..Override::default()
        },
    ));
    assert!(!same_override(
        &Override {
            env: Some(map(&[("A", "1".to_string())])),
            ..Override::default()
        },
        &Override::default(),
    ));
    assert!(!same_override(
        &Override {
            placement: Some(map(&[("o", Placement::Bind)])),
            ..Override::default()
        },
        &Override {
            placement: Some(map(&[("o", Placement::Volume)])),
            ..Override::default()
        },
    ));
}
