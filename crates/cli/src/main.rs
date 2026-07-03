//! `compositz` CLI — the Linux-first control surface (and the desktop app's
//! debugging tool). Eleven subcommands over the ported core; one binary.
//!
//! Each subcommand handler returns the process exit code (`Result<i32>`): `Ok(0)`
//! on success, `Ok(1)` for a handled business failure that already printed its own
//! message, and `Err` for an unexpected error `main` renders as `error: …`. clap
//! handles `--help`/`--version` and argument-shape errors (exiting 2, its default —
//! the Phase 0 convention carried forward).

mod cli;
mod commands;
mod style;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "compositz",
    version,
    about = "run local-AI apps as isolated Docker containers"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Check that the Docker engine is reachable.
    Doctor,
    /// Import a recipe (tar/tar.gz/dir/github:owner/repo) → create an instance.
    Import {
        /// A tar/tar.gz archive, a directory, or `github:owner/repo[/subdir][@ref]`.
        source: String,
    },
    /// List instances in the store.
    Ls,
    /// Derive a fresh instance from an existing one.
    Duplicate { instance_id: String },
    /// Build an instance's image.
    Install { instance_id: String },
    /// Build (if needed) and start an instance.
    Up { instance_id: String },
    /// Stop and remove an instance's container.
    Down { instance_id: String },
    /// Remove an instance incl. data volumes.
    Rm {
        /// Keep the data volumes (the old safe behavior).
        #[arg(long, conflicts_with = "purge")]
        keep_data: bool,
        /// Also remove the host-browsable data-root dir.
        #[arg(long)]
        purge: bool,
        /// One or more instance ids.
        #[arg(required = true)]
        instance_ids: Vec<String>,
    },
    /// Export a mount's data as a tar file (list mounts if omitted).
    Export {
        instance_id: String,
        mount: Option<String>,
        out_file: Option<String>,
    },
    /// List Compositz-managed containers.
    Ps,
    /// Run a full container round-trip against the engine.
    Hello,
}

#[tokio::main]
async fn main() {
    let code = match run().await {
        Ok(code) => code,
        Err(err) => {
            // `{err:#}` prints the whole anyhow context chain.
            eprintln!("{}", style::red(&format!("error: {err:#}")));
            1
        }
    };
    std::process::exit(code);
}

async fn run() -> Result<i32> {
    let cli = Cli::parse();
    match cli.command {
        Command::Doctor => commands::doctor::run().await,
        Command::Import { source } => commands::import::run(source).await,
        Command::Ls => commands::ls::run().await,
        Command::Duplicate { instance_id } => commands::duplicate::run(instance_id).await,
        Command::Install { instance_id } => commands::install::run(instance_id).await,
        Command::Up { instance_id } => commands::up::run(instance_id).await,
        Command::Down { instance_id } => commands::down::run(instance_id).await,
        Command::Rm {
            keep_data,
            purge,
            instance_ids,
        } => commands::rm::run(keep_data, purge, instance_ids).await,
        Command::Export {
            instance_id,
            mount,
            out_file,
        } => commands::export::run(instance_id, mount, out_file).await,
        Command::Ps => commands::ps::run().await,
        Command::Hello => commands::hello::run().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// clap's own structural invariants (unique ids, valid arg relations). Cheap
    /// insurance that the derive stays well-formed as commands are added.
    #[test]
    fn cli_definition_is_well_formed() {
        Cli::command().debug_assert();
    }

    #[test]
    fn rm_rejects_keep_data_and_purge_together() {
        let result = Cli::try_parse_from(["compositz", "rm", "--keep-data", "--purge", "x"]);
        assert!(
            result.is_err(),
            "--keep-data and --purge must be mutually exclusive"
        );
    }

    #[test]
    fn rm_requires_at_least_one_id() {
        assert!(Cli::try_parse_from(["compositz", "rm"]).is_err());
        assert!(Cli::try_parse_from(["compositz", "rm", "--purge"]).is_err());
    }

    #[test]
    fn rm_collects_multiple_ids_with_flags() {
        let cli = Cli::try_parse_from(["compositz", "rm", "--purge", "a", "b", "c"])
            .expect("valid rm invocation");
        match cli.command {
            Command::Rm {
                keep_data,
                purge,
                instance_ids,
            } => {
                assert!(!keep_data);
                assert!(purge);
                assert_eq!(instance_ids, vec!["a", "b", "c"]);
            }
            _ => panic!("expected rm"),
        }
    }

    #[test]
    fn import_requires_a_source() {
        assert!(Cli::try_parse_from(["compositz", "import"]).is_err());
    }

    #[test]
    fn export_takes_optional_mount_and_outfile() {
        let cli = Cli::try_parse_from(["compositz", "export", "app-abc123"])
            .expect("mount and outfile are optional");
        match cli.command {
            Command::Export {
                instance_id,
                mount,
                out_file,
            } => {
                assert_eq!(instance_id, "app-abc123");
                assert_eq!(mount, None);
                assert_eq!(out_file, None);
            }
            _ => panic!("expected export"),
        }
    }

    #[test]
    fn commands_with_no_args_parse() {
        for cmd in [
            vec!["compositz", "doctor"],
            vec!["compositz", "ls"],
            vec!["compositz", "ps"],
            vec!["compositz", "hello"],
        ] {
            assert!(Cli::try_parse_from(&cmd).is_ok(), "{cmd:?} should parse");
        }
    }

    #[test]
    fn unknown_command_is_rejected() {
        assert!(Cli::try_parse_from(["compositz", "frobnicate"]).is_err());
    }
}
