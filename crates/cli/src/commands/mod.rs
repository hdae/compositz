//! One module per subcommand.
//!
//! Every `run` returns the process exit code (`Result<i32>`): `Ok(0)` on success,
//! `Ok(1)` for a handled business failure that prints its own message (`doctor`
//! unreachable, `hello` non-zero exit, `rm` partial failure), and `Err` for an
//! unexpected error the top-level `main` renders as `error: …` and exits 1.

pub mod doctor;
pub mod down;
pub mod duplicate;
pub mod export;
pub mod hello;
pub mod import;
pub mod install;
pub mod ls;
pub mod ps;
pub mod rm;
pub mod up;
