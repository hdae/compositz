//! Single source of truth for the project's externally-visible names.
//!
//! Ported from `packages/core/src/brand.ts`. "compositz" is a WORKING TITLE: the
//! project name, the per-recipe manifest filename, the Docker label namespace,
//! and the image namespace may all change. Keep every such string here so a
//! rename is a one-file edit — never hard-code these elsewhere.

/// Project name. Used for container names and managed-volume prefixes.
pub const BRAND_NAME: &str = "compositz";
/// Manifest filename expected in each recipe bundle.
pub const MANIFEST_FILE: &str = "compositz.yaml";
/// Docker label namespace, e.g. `io.compositz.instance`.
pub const LABEL_PREFIX: &str = "io.compositz";
/// Image repository namespace, e.g. `compositz/<instanceId>`.
pub const IMAGE_NAMESPACE: &str = "compositz";

/// In-container mount root for Compositz-managed caches/venvs, e.g. `/compositz`
/// (= `/` + [`BRAND_NAME`]). Recipe authors read the per-cache paths via injected
/// env vars (see `cache[]`), never this prefix directly.
pub const MANAGED_MOUNT_ROOT: &str = "/compositz";

/// A namespaced Docker label key, e.g. `label("instance")` => `io.compositz.instance`.
pub fn label(suffix: &str) -> String {
    format!("{LABEL_PREFIX}.{suffix}")
}

// Every runtime resource keys off the instance id (ADR-017): one flat namespace,
// no recipe×instance nesting. A `build` recipe's image is per-instance.

/// Per-instance image tag, e.g. `image_tag("comfyui-a1b2c3", "0.1.0")` =>
/// `compositz/comfyui-a1b2c3:0.1.0`.
pub fn image_tag(instance_id: &str, version: &str) -> String {
    format!("{IMAGE_NAMESPACE}/{instance_id}:{version}")
}

/// Container name for an instance, e.g. `compositz-comfyui-a1b2c3`.
pub fn container_name(instance_id: &str) -> String {
    format!("{BRAND_NAME}-{instance_id}")
}

/// Managed named-volume for an instance mount, e.g.
/// `compositz_comfyui-a1b2c3_models`.
pub fn volume_name(instance_id: &str, name: &str) -> String {
    format!("{BRAND_NAME}_{instance_id}_{name}")
}

/// Managed cache volume, not scoped to one recipe (shared/global), e.g.
/// `cache_volume_name("uv")` => `compositz_uv`, `cache_volume_name("cache_torch")`
/// => `compositz_cache_torch`.
pub fn cache_volume_name(suffix: &str) -> String {
    format!("{BRAND_NAME}_{suffix}")
}

/// Env var name Compositz injects into containers, e.g. `env_var("INSTANCE")` =>
/// `COMPOSITZ_INSTANCE`.
pub fn env_var(suffix: &str) -> String {
    format!("{}_{suffix}", BRAND_NAME.to_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    // brand.ts has no dedicated Deno test (it's exercised indirectly). These pin
    // the string shapes directly, because every name here keys a Docker resource
    // (container / volume / image / label) — a format drift silently orphans them.
    #[test]
    fn constants_match_the_working_title() {
        assert_eq!(BRAND_NAME, "compositz");
        assert_eq!(MANIFEST_FILE, "compositz.yaml");
        assert_eq!(LABEL_PREFIX, "io.compositz");
        assert_eq!(IMAGE_NAMESPACE, "compositz");
        assert_eq!(MANAGED_MOUNT_ROOT, "/compositz");
        assert_eq!(MANAGED_MOUNT_ROOT, format!("/{BRAND_NAME}"));
    }

    #[test]
    fn label_is_namespaced() {
        assert_eq!(label("instance"), "io.compositz.instance");
        assert_eq!(label("recipe"), "io.compositz.recipe");
    }

    #[test]
    fn image_tag_joins_namespace_id_and_version() {
        assert_eq!(
            image_tag("comfyui-a1b2c3", "0.1.0"),
            "compositz/comfyui-a1b2c3:0.1.0"
        );
    }

    #[test]
    fn container_name_prefixes_with_a_hyphen() {
        assert_eq!(container_name("comfyui-a1b2c3"), "compositz-comfyui-a1b2c3");
    }

    #[test]
    fn volume_name_joins_with_underscores() {
        assert_eq!(
            volume_name("comfyui-a1b2c3", "models"),
            "compositz_comfyui-a1b2c3_models"
        );
    }

    #[test]
    fn cache_volume_name_prefixes_the_suffix() {
        assert_eq!(cache_volume_name("uv"), "compositz_uv");
        assert_eq!(cache_volume_name("cache_torch"), "compositz_cache_torch");
    }

    #[test]
    fn env_var_upcases_the_brand() {
        assert_eq!(env_var("INSTANCE"), "COMPOSITZ_INSTANCE");
        assert_eq!(env_var("DOCKER_HOST"), "COMPOSITZ_DOCKER_HOST");
    }
}
