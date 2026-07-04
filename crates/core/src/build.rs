//! Build-context types and packing. A recipe's build context is a Dockerfile plus
//! a few provisioning files, small enough to hold in memory.
//!
//! [`BuildFile`] is used by the instance store; [`tar_context`] packs the context
//! into an uncompressed tar for the Engine's `POST /build` during install.

use std::io::Write;

use crate::Error;

/// One file in a recipe's build context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildFile {
    /// Path within the context root, forward-slash separated (e.g. `Dockerfile`
    /// or `rootfs/run.sh`).
    pub path: String,
    /// The file's raw bytes.
    pub data: Vec<u8>,
}

/// Pack files into an uncompressed (ustar/gnu) tar archive the Docker daemon can
/// consume as a build context. Recipes are small, so building the whole archive in
/// memory is fine (streaming a large context is a later optimization).
pub fn tar_context(files: &[BuildFile]) -> Result<Vec<u8>, Error> {
    let mut builder = tar::Builder::new(Vec::new());
    for file in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(file.data.len() as u64);
        header.set_mode(0o644);
        // Deterministic mtime — the daemon ignores it and it keeps the archive
        // reproducible (identical context ⇒ identical bytes ⇒ cache-friendly).
        header.set_mtime(0);
        // `append_data` writes the path into the header (a GNU long-name extension
        // for paths over 100 bytes) and finalizes the checksum.
        builder
            .append_data(&mut header, &file.path, file.data.as_slice())
            .map_err(Error::from)?;
    }
    // `into_inner` finishes the archive (writes the trailing zero blocks) if it
    // hasn't been finished yet, then returns the underlying buffer.
    builder.into_inner().map_err(Error::from).and_then(|mut w| {
        w.flush().map_err(Error::from)?;
        Ok(w)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::io::{Cursor, Read};

    #[test]
    fn tar_context_packs_files_and_reads_back_as_a_valid_tar() {
        let files = vec![
            BuildFile {
                path: "Dockerfile".to_string(),
                data: b"FROM scratch\n".to_vec(),
            },
            BuildFile {
                path: "rootfs/run.sh".to_string(),
                data: b"#!/bin/sh\n".to_vec(),
            },
        ];
        let tar = tar_context(&files).unwrap();

        // The daemon reads this with a standard tar reader — so must our test.
        let mut archive = tar::Archive::new(Cursor::new(tar));
        let mut found: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for entry in archive.entries().unwrap() {
            let mut entry = entry.unwrap();
            let path = entry.path().unwrap().to_string_lossy().into_owned();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            found.insert(path, data);
        }
        assert_eq!(
            found.get("Dockerfile").map(Vec::as_slice),
            Some(b"FROM scratch\n".as_slice())
        );
        assert_eq!(
            found.get("rootfs/run.sh").map(Vec::as_slice),
            Some(b"#!/bin/sh\n".as_slice())
        );
    }
}
