//! Read-only metadata checks: no prompt, redirects or provider response bodies
//! in the result. Credentials stay in the Rust core.
use crate::settings::ProviderConfig;
use reqwest::{blocking::Client, redirect::Policy};
use serde::Serialize;
use serde_json::Value;
use std::{io::Read, time::Duration};
use url::{Host, Url};

const BODY_LIMIT: u64 = 512 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ModelConnection {
    pub state: &'static str,
    pub reason: &'static str,
}
impl ModelConnection {
    pub fn unavailable(reason: &'static str) -> Self {
        Self {
            state: "unavailable",
            reason,
        }
    }
    fn unknown(reason: &'static str) -> Self {
        Self {
            state: "unknown",
            reason,
        }
    }
    fn available() -> Self {
        Self {
            state: "available",
            reason: "model_listed",
        }
    }
}

fn endpoint(provider: &ProviderConfig) -> Option<(Url, &str, bool)> {
    let (base, model, anthropic) = match provider {
        ProviderConfig::OpenAi {
            base_url, model, ..
        } => (
            base_url.as_deref().unwrap_or("https://api.openai.com/v1"),
            model.as_str(),
            false,
        ),
        ProviderConfig::OpenAiCompatible {
            base_url, model, ..
        } => (base_url.as_str(), model.as_str(), false),
        ProviderConfig::Anthropic { model, .. } => {
            ("https://api.anthropic.com/v1", model.as_str(), true)
        }
    };
    let mut url = Url::parse(base).ok()?;
    let local = matches!(url.host(), Some(Host::Ipv4(ip)) if ip.is_loopback())
        || matches!(url.host(), Some(Host::Ipv6(ip)) if ip.is_loopback());
    if !(url.scheme() == "https" || url.scheme() == "http" && local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || model.is_empty()
    {
        return None;
    }
    url.set_path(&format!("{}/models", url.path().trim_end_matches('/')));
    Some((url, model, anthropic))
}

fn listed(body: &[u8], model: &str) -> ModelConnection {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return ModelConnection::unknown("unsupported_response");
    };
    let Some(models) = value.get("data").and_then(Value::as_array) else {
        return ModelConnection::unknown("unsupported_response");
    };
    if models
        .iter()
        .any(|item| item.get("id").and_then(Value::as_str) == Some(model))
    {
        ModelConnection::available()
    } else if value.get("has_more").and_then(Value::as_bool) == Some(true) {
        ModelConnection::unknown("partial_listing")
    } else {
        ModelConnection::unavailable("model_missing")
    }
}

pub fn probe(provider: &ProviderConfig) -> ModelConnection {
    let Some((url, model, anthropic)) = endpoint(provider) else {
        return ModelConnection::unavailable("invalid_config");
    };
    let mut builder = Client::builder()
        .redirect(Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6));
    if matches!(url.host(), Some(Host::Ipv4(ip)) if ip.is_loopback())
        || matches!(url.host(), Some(Host::Ipv6(ip)) if ip.is_loopback())
    {
        builder = builder.no_proxy();
    }
    let Ok(client) = builder.build() else {
        return ModelConnection::unavailable("unreachable");
    };
    let mut request = client.get(url).header("Accept", "application/json");
    if let Some(key) = provider.api_key().filter(|key| !key.is_empty()) {
        request = if anthropic {
            request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
        } else {
            request.bearer_auth(key)
        };
    }
    let Ok(response) = request.send() else {
        return ModelConnection::unavailable("unreachable");
    };
    match response.status().as_u16() {
        401 | 403 => return ModelConnection::unavailable("unauthorized"),
        404 | 405 | 501 => return ModelConnection::unknown("unsupported_endpoint"),
        200..=299 => (),
        _ => return ModelConnection::unavailable("service_error"),
    }
    let mut body = Vec::new();
    if response
        .take(BODY_LIMIT + 1)
        .read_to_end(&mut body)
        .is_err()
    {
        return ModelConnection::unavailable("unreachable");
    }
    if body.len() as u64 > BODY_LIMIT {
        return ModelConnection::unknown("response_too_large");
    }
    listed(&body, model)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, thread};
    fn provider(base: &str) -> ProviderConfig {
        ProviderConfig::OpenAiCompatible {
            base_url: base.into(),
            model: "test-model".into(),
            api_key: Some("synthetic-key".into()),
        }
    }
    #[test]
    fn validates_fixed_metadata_destination() {
        assert_eq!(
            endpoint(&provider("http://127.0.0.1:1234/v1/"))
                .unwrap()
                .0
                .as_str(),
            "http://127.0.0.1:1234/v1/models"
        );
        for bad in [
            "http://example.com/v1",
            "https://key@example.com/v1",
            "https://example.com/v1?key=secret",
            "https://example.com/#x",
            "file:///etc/passwd",
        ] {
            assert!(endpoint(&provider(bad)).is_none());
        }
    }
    #[test]
    fn requires_selected_model_and_handles_partial_or_unknown_listings() {
        assert_eq!(
            listed(br#"{"data":[{"id":"test-model"}]}"#, "test-model").state,
            "available"
        );
        assert_eq!(
            listed(br#"{"data":[]}"#, "test-model").reason,
            "model_missing"
        );
        assert_eq!(
            listed(br#"{"data":[],"has_more":true}"#, "test-model").state,
            "unknown"
        );
        assert_eq!(listed(b"<html>ok</html>", "test-model").state, "unknown");
    }
    #[test]
    fn sends_only_metadata_get_and_never_follows_redirects() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut bytes = [0; 4096];
            let size = stream.read(&mut bytes).unwrap();
            let request = String::from_utf8_lossy(&bytes[..size]);
            assert!(request.starts_with("GET /v1/models HTTP/1.1\r\n"));
            assert!(request
                .to_lowercase()
                .contains("authorization: bearer synthetic-key"));
            assert!(!request.contains("messages") && !request.contains("prompt"));
            use std::io::Write;
            stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        assert_eq!(probe(&provider(&url)).reason, "service_error");
        server.join().unwrap();
    }
    #[test]
    fn real_http_requires_authenticated_model_listing_without_returning_body() {
        for (status, body, expected) in [
            ("200 OK", r#"{"data":[{"id":"test-model"}]}"#, "available"),
            ("200 OK", r#"{"data":[]}"#, "unavailable"),
            (
                "401 Unauthorized",
                r#"{"error":"synthetic-private-account-detail"}"#,
                "unavailable",
            ),
            ("404 Not Found", "unsupported", "unknown"),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/v1", listener.local_addr().unwrap());
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let _ = stream.read(&mut request).unwrap();
                use std::io::Write;
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            let result = probe(&provider(&url));
            assert_eq!(result.state, expected);
            let public = serde_json::to_string(&result).unwrap();
            assert!(
                !public.contains("synthetic-key")
                    && !public.contains("account-detail")
                    && !public.contains("http")
            );
            server.join().unwrap();
        }
    }
}
