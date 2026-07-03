//! Terminal color helpers, TTY- and `NO_COLOR`-aware.
//!
//! Mirrors the Deno CLI's `@std/fmt/colors` usage: colors are emitted only when
//! stdout is a terminal and `NO_COLOR` is unset (a single global gate, evaluated
//! once). Piping the output or setting `NO_COLOR` yields plain text, so redirected
//! logs never carry escape sequences. Each helper returns an owned `String` so
//! callers can concatenate colored + plain fragments freely.

use std::io::IsTerminal;
use std::sync::LazyLock;

/// Whether to emit ANSI color — decided once from stdout's TTY-ness + `NO_COLOR`
/// (parity with Deno's `Deno.noColor`, which keys off the same two signals).
static COLOR: LazyLock<bool> =
    LazyLock::new(|| std::env::var_os("NO_COLOR").is_none() && std::io::stdout().is_terminal());

fn paint(code: &str, text: &str) -> String {
    if *COLOR {
        format!("\x1b[{code}m{text}\x1b[0m")
    } else {
        text.to_string()
    }
}

pub fn red(text: &str) -> String {
    paint("31", text)
}

pub fn green(text: &str) -> String {
    paint("32", text)
}

pub fn yellow(text: &str) -> String {
    paint("33", text)
}

pub fn cyan(text: &str) -> String {
    paint("36", text)
}

pub fn dim(text: &str) -> String {
    paint("2", text)
}

pub fn bold(text: &str) -> String {
    paint("1", text)
}
