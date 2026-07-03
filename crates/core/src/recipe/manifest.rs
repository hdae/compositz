//! The Compositz recipe manifest (`compositz.yaml`): a single-container app
//! description, kept separate from the Dockerfile (Umbrel-style). Authored in YAML.
//!
//! Ported from `packages/core/src/recipe/manifest.ts`. In the Deno tree a single
//! Zod schema was the source of truth (validator + inferred types + JSON Schema).
//! Here that splits cleanly along Rust's grain:
//!
//! - **Structure** — shapes, types, enum variants, the `type`-tagged cache union,
//!   and unknown-key rejection (`deny_unknown_fields`) — is handled by serde while
//!   deserializing the YAML. serde_norway prefixes the offending field into its
//!   error text (e.g. `gpu: unknown variant ...`), so those messages stay legible.
//! - **Refinements** — the per-field regex/range/literal rules and the cross-field
//!   rules (build XOR image, uniqueness, duplicate mount targets) that a schema
//!   can't express — are the explicit code in [`validate`], which reproduces the
//!   Zod `superRefine` messages verbatim, path-tagged as `manifest.<path> <msg>`.
//!
//! The [`schemars::JsonSchema`] derives back the JSON Schema document that the
//! Deno `scripts/gen_schema.ts` used to emit from Zod.

use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::Error;

/// The only manifest schema version this build understands.
pub const MANIFEST_VERSION: u32 = 2;

// --- Charsets (the single source of truth, ported 1:1 from the Zod regexes) ---

/// The recipe `id` charset. It keys the image, container, data dirs, and labels,
/// and flows into filesystem paths, so any id accepted from outside (e.g. a UI
/// route) MUST be validated against this.
static RECIPE_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,62}$").unwrap());

/// Names flow into host paths (`<data-root>/<id>/<name>`), volume names, and
/// override keys — no dots or slashes, which blocks path traversal and yields
/// valid Docker volume names.
static NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$").unwrap());
const NAME_MSG: &str = "must be alphanumeric/underscore/hyphen, 1-63 chars, starting alphanumeric (no dots or slashes)";

/// A POSIX environment variable name (also blocks `=` breaking `NAME=value`).
static ENV_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*$").unwrap());
const ENV_NAME_MSG: &str = "must be a valid env var name";

/// `version` is used as the Docker image TAG, so it is constrained to the tag
/// charset (also blocks blanks and request-line injection — it reaches the
/// Engine HTTP path).
static VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$").unwrap());

/// `image` reaches the Engine HTTP path unencoded — constrain to a safe ref charset.
static IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._:/@-]*$").unwrap());

/// Whether an id from outside is a legal recipe id (see [`RECIPE_ID`]).
pub fn is_valid_recipe_id(id: &str) -> bool {
    RECIPE_ID.is_match(id)
}

// --- Enums ---

/// GPU policy: `required` fails without a GPU; `preferred` tries GPU then falls
/// back to CPU; `none` never attaches one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GpuMode {
    Required,
    #[default]
    Preferred,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    #[default]
    Tcp,
    Udp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Bind,
    #[default]
    Volume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum CacheScope {
    #[default]
    Shared,
    Instance,
}

// --- Object schemas ---

/// Build the image from a Dockerfile context (mutually exclusive with `image`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BuildSpec {
    #[serde(default = "default_dockerfile")]
    pub dockerfile: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<BTreeMap<String, String>>,
}

fn default_dockerfile() -> String {
    "Dockerfile".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PortMapping {
    /// Stable key — UI button label and per-install override key.
    pub name: String,
    /// Port the app listens on inside the container.
    pub container: u32,
    /// Host port to publish on (default = container; auto-bumped on conflict).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<u32>,
    #[serde(default)]
    pub protocol: Protocol,
    /// Serves a browser UI — renders an "Open UI" button. Multiple allowed.
    #[serde(default)]
    pub web: bool,
    /// UI path (absolute), used to build the open URL.
    #[serde(default = "default_root_path")]
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn default_root_path() -> String {
    "/".to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MountMapping {
    /// Stable key — host subdir / volume suffix.
    pub name: String,
    /// In-container mount path (absolute).
    pub target: String,
    #[serde(default)]
    pub placement: Placement,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Opt-in managed cache. Presets (`venv`, `huggingface`) inject well-known env
/// vars; `custom` names its own volume + injected env var.
///
/// `Deserialize` is hand-written rather than derived: the Zod source uses a
/// `strictObject` per variant, so an unknown key *inside* a cache entry must be
/// rejected. serde's internally-tagged enums (`#[serde(tag = ...)]`) cannot carry
/// `deny_unknown_fields`, so the derive would silently drop such keys — a parity
/// regression against the source-of-truth spec. The impl below buffers each entry,
/// reads its `type`, and re-deserializes through a per-variant struct that *does*
/// deny unknown fields. `Serialize` / `JsonSchema` stay derived (internally tagged).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CacheSpec {
    /// Per-instance uv venv + co-located uv cache/interpreters on one shared
    /// volume (hardlink-safe). Injects `VIRTUAL_ENV` + `UV_PROJECT_ENVIRONMENT`
    /// (same path) + `UV_CACHE_DIR` + `UV_PYTHON_INSTALL_DIR`.
    Venv,
    /// Shared HuggingFace hub cache. Injects `HF_HOME`.
    Huggingface,
    /// A named cache injected into a chosen env var.
    Custom {
        /// Cache key (volume suffix).
        name: String,
        /// Env var the mount path is injected into.
        env: String,
        /// `shared` => one cache across apps; `instance` => a per-instance subpath.
        #[serde(default)]
        scope: CacheScope,
    },
}

impl<'de> Deserialize<'de> for CacheSpec {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error as _;

        // A preset entry (`venv`/`huggingface`) carries only `type`; anything else
        // is an unrecognized key, matching the Zod `strictObject`.
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct PresetEntry {
            #[serde(rename = "type")]
            _type: String,
        }

        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct CustomEntry {
            #[serde(rename = "type")]
            _type: String,
            name: String,
            env: String,
            #[serde(default)]
            scope: CacheScope,
        }

        // Buffer the whole entry so we can peek at `type` and then hand the same
        // node to the strict per-variant struct.
        let value = serde_norway::Value::deserialize(deserializer)?;
        let tag = value
            .get("type")
            .and_then(serde_norway::Value::as_str)
            .ok_or_else(|| D::Error::custom("cache entry is missing a string `type`"))?
            .to_owned();

        match tag.as_str() {
            "venv" => {
                serde_norway::from_value::<PresetEntry>(value).map_err(D::Error::custom)?;
                Ok(CacheSpec::Venv)
            }
            "huggingface" => {
                serde_norway::from_value::<PresetEntry>(value).map_err(D::Error::custom)?;
                Ok(CacheSpec::Huggingface)
            }
            "custom" => {
                let entry =
                    serde_norway::from_value::<CustomEntry>(value).map_err(D::Error::custom)?;
                Ok(CacheSpec::Custom {
                    name: entry.name,
                    env: entry.env,
                    scope: entry.scope,
                })
            }
            other => Err(D::Error::custom(format!(
                "unknown cache `type` \"{other}\", expected one of `venv`, `huggingface`, `custom`"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EnvSpec {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// The user must confirm a value before launch.
    #[serde(default)]
    pub required: bool,
    /// Suggested/placeholder value (coexists with `required`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<String>,
}

/// A parsed + validated recipe manifest. Construct only via [`parse_manifest`],
/// which applies the cross-field refinements a plain deserialize can't.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(title = "Compositz recipe manifest")]
pub struct Manifest {
    pub manifest_version: u32,
    /// Key for image/container/data/labels.
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build: Option<BuildSpec>,
    /// Prebuilt image reference (mutually exclusive with `build`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(default)]
    pub ports: Vec<PortMapping>,
    /// Persisted data. Declared => kept across restarts.
    #[serde(default)]
    pub mounts: Vec<MountMapping>,
    /// Opt-in managed caches; paths injected as env vars.
    #[serde(default)]
    pub cache: Vec<CacheSpec>,
    #[serde(default)]
    pub env: Vec<EnvSpec>,
    #[serde(default)]
    pub gpu: GpuMode,
}

/// Parse + validate a manifest from YAML text. Returns [`Error::Manifest`] on any
/// problem, with a message mirroring the Deno `CompositzError` text.
pub fn parse_manifest(yaml_text: &str) -> Result<Manifest, Error> {
    // serde handles structure (types, enum variants, the tagged cache union,
    // unknown keys) and YAML syntax; its message already names the offending field.
    let manifest: Manifest = serde_norway::from_str(yaml_text)
        .map_err(|e| Error::Manifest(format!("manifest is not valid: {e}")))?;
    validate(&manifest)?;
    Ok(manifest)
}

/// The manifest schema as a JSON Schema document (for recipe authors / agents).
///
/// Generated from the structural types: the cross-field refinements (XOR,
/// uniqueness) are enforced by [`validate`] but have no faithful JSON Schema form,
/// exactly as in the Deno `manifestJsonSchema()`.
pub fn manifest_json_schema() -> schemars::Schema {
    schemars::schema_for!(Manifest)
}

/// One validation problem: a `manifest.<path>`-relative location and a message.
struct Issue {
    path: String,
    message: String,
}

/// Apply the refinements a structural deserialize cannot express, collecting
/// every problem before failing (mirrors Zod's issue list, joined with `; `).
fn validate(m: &Manifest) -> Result<(), Error> {
    let mut issues: Vec<Issue> = Vec::new();
    let mut add = |path: String, message: &str| {
        issues.push(Issue {
            path,
            message: message.to_string(),
        })
    };

    // manifestVersion is a literal in the Zod schema; serde reads it as a number,
    // so the "must be 2" check lives here.
    if m.manifest_version != MANIFEST_VERSION {
        add(
            "manifestVersion".into(),
            &format!("must be {MANIFEST_VERSION}"),
        );
    }
    if !RECIPE_ID.is_match(&m.id) {
        add(
            "id".into(),
            "must be lowercase alphanumeric/hyphen, 1-63 chars, starting alphanumeric",
        );
    }
    // `/\S/`: at least one non-whitespace character.
    if !m.name.chars().any(|c| !c.is_whitespace()) {
        add("name".into(), "must not be blank");
    }
    if !VERSION.is_match(&m.version) {
        add(
            "version".into(),
            "must be a valid image tag (alphanumeric plus . _ -, max 128 chars)",
        );
    }
    if let Some(image) = &m.image
        && !IMAGE.is_match(image)
    {
        add("image".into(), "must be a valid image reference");
    }

    // Ports.
    for (i, p) in m.ports.iter().enumerate() {
        if !NAME.is_match(&p.name) {
            add(format!("ports[{i}].name"), NAME_MSG);
        }
        if !is_port(p.container) {
            add(
                format!("ports[{i}].container"),
                "must be an integer between 1 and 65535",
            );
        }
        if let Some(host) = p.host
            && !is_port(host)
        {
            add(
                format!("ports[{i}].host"),
                "must be an integer between 1 and 65535",
            );
        }
        // `/^\//`
        if !p.path.starts_with('/') {
            add(format!("ports[{i}].path"), "must start with '/'");
        }
    }

    // Mounts. Two mounts to one in-container target is an invalid spec.
    let mut targets: HashSet<&str> = HashSet::new();
    for (i, mt) in m.mounts.iter().enumerate() {
        if !NAME.is_match(&mt.name) {
            add(format!("mounts[{i}].name"), NAME_MSG);
        }
        if !mt.target.starts_with('/') {
            add(format!("mounts[{i}].target"), "must be an absolute path");
        }
        if !targets.insert(mt.target.as_str()) {
            add(
                format!("mounts[{i}].target"),
                &format!("duplicate mount target \"{}\"", mt.target),
            );
        }
    }

    // Env var names.
    for (i, e) in m.env.iter().enumerate() {
        if !ENV_NAME.is_match(&e.name) {
            add(format!("env[{i}].name"), ENV_NAME_MSG);
        }
    }

    // Custom cache name/env charsets (presets carry no free-form fields).
    for (i, c) in m.cache.iter().enumerate() {
        if let CacheSpec::Custom { name, env, .. } = c {
            if !NAME.is_match(name) {
                add(format!("cache[{i}].name"), NAME_MSG);
            }
            if !ENV_NAME.is_match(env) {
                add(format!("cache[{i}].env"), ENV_NAME_MSG);
            }
        }
    }

    // build XOR image — exactly one image source.
    match (m.build.is_some(), m.image.is_some()) {
        (false, false) => add("(root)".into(), "one of `build` or `image` is required"),
        (true, true) => add("image".into(), "`build` and `image` are mutually exclusive"),
        _ => {}
    }

    // Unique names within each list; caches keyed by preset type or `custom:<name>`.
    report_duplicates(&mut issues, "ports", m.ports.iter().map(|p| p.name.clone()));
    report_duplicates(
        &mut issues,
        "mounts",
        m.mounts.iter().map(|mt| mt.name.clone()),
    );
    report_duplicates(&mut issues, "env", m.env.iter().map(|e| e.name.clone()));
    report_duplicates(&mut issues, "cache", m.cache.iter().map(cache_key));

    if issues.is_empty() {
        return Ok(());
    }
    let message = issues
        .iter()
        .map(|i| format!("manifest.{} {}", i.path, i.message))
        .collect::<Vec<_>>()
        .join("; ");
    Err(Error::Manifest(message))
}

fn is_port(n: u32) -> bool {
    (1..=65535).contains(&n)
}

/// The uniqueness key for a cache entry: the preset name, or `custom:<name>` so
/// two custom caches with distinct names don't collide.
fn cache_key(c: &CacheSpec) -> String {
    match c {
        CacheSpec::Venv => "venv".to_string(),
        CacheSpec::Huggingface => "huggingface".to_string(),
        CacheSpec::Custom { name, .. } => format!("custom:{name}"),
    }
}

/// Flag the second and later occurrence of any repeated key, tagged at the
/// duplicate's index (`manifest.<field>[<i>] duplicate <field> entry "<key>"`).
fn report_duplicates(issues: &mut Vec<Issue>, field: &str, keys: impl Iterator<Item = String>) {
    let mut seen: HashSet<String> = HashSet::new();
    for (i, key) in keys.enumerate() {
        if !seen.insert(key.clone()) {
            issues.push(Issue {
                path: format!("{field}[{i}]"),
                message: format!("duplicate {field} entry \"{key}\""),
            });
        }
    }
}
