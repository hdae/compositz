//! `COMPOSITZ_DOCKER_HOST` parsing into a resolved [`Endpoint`].

use crate::error::Error;

/// A resolved engine endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Endpoint {
    /// Unix domain socket (Linux/macOS).
    Unix { path: String },
    /// Windows named pipe.
    Npipe { path: String },
    /// TCP host:port (plain HTTP; TLS is not supported).
    Tcp { host: String, port: u16 },
}

/// Parse a `DOCKER_HOST`-style string into an [`Endpoint`].
///
/// Accepts `unix://`, `npipe://`, `tcp://`, and `http://`. A `tcp`/`http` URL
/// without an explicit port defaults to 2375 (the plain-HTTP engine port).
pub fn parse_docker_host(raw: &str) -> Result<Endpoint, Error> {
    if let Some(path) = raw.strip_prefix("unix://") {
        return Ok(Endpoint::Unix {
            path: path.to_string(),
        });
    }
    if let Some(rest) = raw.strip_prefix("npipe://") {
        // e.g. "npipe:////./pipe/docker_engine" -> "\\.\pipe\docker_engine"
        let path = rest.replace('/', "\\");
        return Ok(Endpoint::Npipe { path });
    }
    if let Some(rest) = raw
        .strip_prefix("tcp://")
        .or_else(|| raw.strip_prefix("http://"))
    {
        let (host, port) = split_host_port(rest)?;
        return Ok(Endpoint::Tcp { host, port });
    }
    Err(Error::UnsupportedDockerHost(raw.to_string()))
}

/// Split a `host[:port][/path]` authority into host + port (default 2375),
/// dropping any trailing path/query the way a URL parse would.
fn split_host_port(authority: &str) -> Result<(String, u16), Error> {
    let authority = authority.split(['/', '?', '#']).next().unwrap_or(authority);
    match authority.rsplit_once(':') {
        Some((host, port_str)) if !host.is_empty() => {
            let port = port_str
                .parse::<u16>()
                .map_err(|_| Error::UnsupportedDockerHost(authority.to_string()))?;
            Ok((host.to_string(), port))
        }
        // No colon → host only, default port.
        _ if !authority.is_empty() => Ok((authority.to_string(), 2375)),
        _ => Err(Error::UnsupportedDockerHost(authority.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unix() {
        assert_eq!(
            parse_docker_host("unix:///var/run/docker.sock").unwrap(),
            Endpoint::Unix {
                path: "/var/run/docker.sock".to_string()
            }
        );
    }

    #[test]
    fn parses_npipe_normalizing_slashes() {
        assert_eq!(
            parse_docker_host("npipe:////./pipe/docker_engine").unwrap(),
            Endpoint::Npipe {
                path: r"\\.\pipe\docker_engine".to_string()
            }
        );
    }

    #[test]
    fn parses_tcp() {
        assert_eq!(
            parse_docker_host("tcp://127.0.0.1:2375").unwrap(),
            Endpoint::Tcp {
                host: "127.0.0.1".to_string(),
                port: 2375
            }
        );
    }

    #[test]
    fn parses_http_as_tcp() {
        assert_eq!(
            parse_docker_host("http://host.docker.internal:2375").unwrap(),
            Endpoint::Tcp {
                host: "host.docker.internal".to_string(),
                port: 2375
            }
        );
    }

    #[test]
    fn tcp_without_port_defaults_to_2375() {
        assert_eq!(
            parse_docker_host("tcp://192.168.1.5").unwrap(),
            Endpoint::Tcp {
                host: "192.168.1.5".to_string(),
                port: 2375
            }
        );
    }

    #[test]
    fn tcp_with_trailing_path_drops_it() {
        assert_eq!(
            parse_docker_host("tcp://example.com:2376/v1.40").unwrap(),
            Endpoint::Tcp {
                host: "example.com".to_string(),
                port: 2376
            }
        );
    }

    #[test]
    fn rejects_unknown_scheme() {
        assert!(matches!(
            parse_docker_host("ssh://host"),
            Err(Error::UnsupportedDockerHost(_))
        ));
    }

    #[test]
    fn rejects_non_numeric_port() {
        assert!(matches!(
            parse_docker_host("tcp://host:notaport"),
            Err(Error::UnsupportedDockerHost(_))
        ));
    }
}
