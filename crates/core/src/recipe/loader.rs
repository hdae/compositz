//! Load a recipe BUNDLE from a directory: parse + validate its manifest and read
//! the build context (Dockerfile + assets) into memory. Recipes are small.
//!
//! Ported from `packages/core/src/recipe/loader.ts`. A bundle is what an instance
//! is created from (it lives at `<instance>/app/`); the deployed unit is an
//! [`crate::recipe::instance::Instance`]. Used by ingestion to validate, and by
//! instance loading to read the embedded bundle.

use crate::Error;
use crate::brand;
use crate::build::BuildFile;
use crate::recipe::manifest::{Manifest, parse_manifest};
use crate::recipe::norm_dir;

/// A validated recipe bundle: its manifest and in-memory build context.
#[derive(Debug, Clone)]
pub struct Recipe {
    pub id: String,
    /// Recipe directory, normalized to forward slashes.
    pub dir: String,
    pub manifest: Manifest,
    /// Build-context files with POSIX-relative paths (excludes the manifest).
    pub context: Vec<BuildFile>,
}

/// Load + validate the recipe bundle rooted at `dir`.
pub fn load_recipe(dir: &str) -> Result<Recipe, Error> {
    let root = norm_dir(dir);
    let manifest_path = format!("{root}/{}", brand::MANIFEST_FILE);

    let text = std::fs::read_to_string(&manifest_path)
        .map_err(|_| Error::Recipe(format!("recipe manifest not found: {manifest_path}")))?;
    let manifest = parse_manifest(&text)?;

    let mut context = Vec::new();
    for (abs, rel) in walk(&root)? {
        if rel == brand::MANIFEST_FILE {
            continue; // the manifest is not build context
        }
        if rel.split('/').any(|seg| seg.starts_with('.')) {
            continue; // skip dotfiles/dirs
        }
        context.push(BuildFile {
            path: rel,
            data: std::fs::read(&abs)?,
        });
    }

    // `image`-based recipes have no build context to validate.
    if let Some(build) = &manifest.build
        && !context.iter().any(|f| f.path == build.dockerfile)
    {
        return Err(Error::Recipe(format!(
            "recipe \"{}\": Dockerfile \"{}\" not found in {root}",
            manifest.id, build.dockerfile
        )));
    }

    Ok(Recipe {
        id: manifest.id.clone(),
        dir: root,
        manifest,
        context,
    })
}

/// Recursively collect every file under `root` as `(absolute, root-relative)`
/// forward-slash paths.
fn walk(root: &str) -> Result<Vec<(String, String)>, Error> {
    let mut out = Vec::new();
    walk_into(root, root, &mut out)?;
    Ok(out)
}

fn walk_into(base: &str, dir: &str, out: &mut Vec<(String, String)>) -> Result<(), Error> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let abs = format!("{dir}/{}", name.to_string_lossy());
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            walk_into(base, &abs, out)?;
        } else if file_type.is_file() {
            // `base` + '/' is one byte past a valid boundary, so the slice is
            // always on a char boundary (the separator is ASCII '/').
            let rel = abs[base.len() + 1..].to_string();
            out.push((abs, rel));
        }
    }
    Ok(())
}
