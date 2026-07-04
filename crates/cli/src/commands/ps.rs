//! `ps` — list Compositz-managed containers as an aligned table via
//! [`list_managed_containers`].
//!
//! NOTE: the table shape is NAME/STATE/IMAGE/PORTS with a label-`instance`
//! filter (rather than NAME/STATE/APP/PORTS with a `managed=true` filter) — an
//! accepted, pre-existing divergence.

use anyhow::Result;
use compositz_core::{ContainerSummary, connect, list_managed_containers};

/// List managed containers (running and stopped) as a left-aligned table.
pub async fn run() -> Result<i32> {
    let handle = connect()?;
    let instances = list_managed_containers(&handle).await?;
    print!("{}", render_table(&instances));
    Ok(0)
}

/// Render the summaries as a left-aligned NAME/STATE/IMAGE/PORTS table. Column
/// widths flex to the widest cell (header included). Kept pure for testability.
fn render_table(instances: &[ContainerSummary]) -> String {
    const HEADERS: [&str; 4] = ["NAME", "STATE", "IMAGE", "PORTS"];

    let rows: Vec<[String; 4]> = instances
        .iter()
        .map(|c| {
            [
                c.name.clone(),
                c.state.clone(),
                c.image.clone(),
                c.ports.join(", "),
            ]
        })
        .collect();

    let mut widths = HEADERS.map(str::len);
    for row in &rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.len());
        }
    }

    let mut out = String::new();
    push_row(&mut out, &HEADERS.map(String::from), &widths);
    for row in &rows {
        push_row(&mut out, row, &widths);
    }
    out
}

/// Append one padded row (columns joined by two spaces, no trailing padding on
/// the last column, one trailing newline).
fn push_row(out: &mut String, cells: &[String; 4], widths: &[usize; 4]) {
    for (i, cell) in cells.iter().enumerate() {
        if i > 0 {
            out.push_str("  ");
        }
        if i == cells.len() - 1 {
            out.push_str(cell);
        } else {
            out.push_str(cell);
            for _ in cell.len()..widths[i] {
                out.push(' ');
            }
        }
    }
    out.push('\n');
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(name: &str, state: &str, image: &str, ports: &[&str]) -> ContainerSummary {
        ContainerSummary {
            id: format!("id-{name}"),
            name: name.to_string(),
            state: state.to_string(),
            image: image.to_string(),
            ports: ports.iter().map(|p| p.to_string()).collect(),
        }
    }

    #[test]
    fn table_has_header_row_even_when_empty() {
        let out = render_table(&[]);
        assert_eq!(out, "NAME  STATE  IMAGE  PORTS\n");
    }

    #[test]
    fn columns_align_to_widest_cell() {
        let rows = vec![
            summary(
                "comfyui-a1b2c3",
                "running",
                "compositz/comfyui:0.1.0",
                &["8188->8188/tcp"],
            ),
            summary("web-x", "exited", "nginx", &[]),
        ];
        let out = render_table(&rows);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 3);
        // Every line's STATE column starts at the same offset (name width = 14).
        let name_width = "comfyui-a1b2c3".len();
        for line in &lines {
            assert_eq!(&line[name_width..name_width + 2], "  ");
        }
    }

    #[test]
    fn multiple_ports_joined_with_comma() {
        let out = render_table(&[summary(
            "multi",
            "running",
            "img",
            &["80->80/tcp", "443->443/tcp"],
        )]);
        assert!(out.contains("80->80/tcp, 443->443/tcp"));
    }
}
