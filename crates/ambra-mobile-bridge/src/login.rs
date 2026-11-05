//! Service sign-in on the phone, as desktop does it (`desktop/src-tauri/src/service_login.rs`):
//! the service redirects the in-app browser to a loopback address on this phone, where this
//! listener takes the callback and hands it to the app, which sends it to the server.

use std::sync::Mutex;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

type Result<T> = std::result::Result<T, String>;

struct Waiting {
    task: tokio::task::JoinHandle<()>,
}

static WAITING: Mutex<Option<Waiting>> = Mutex::new(None);
static CAPTURED: Mutex<Option<String>> = Mutex::new(None);

const PAGE: &str = "<!doctype html><meta name=viewport content='width=device-width'><body style='background:#000;color:#fff;font:17px -apple-system,sans-serif;text-align:center;padding-top:30vh'>Signed in. You can return to AMBRA.</body>";

/// Only the loopback redirects the services use; anything else is refused.
fn parse(redirect: &str) -> Result<(u16, String)> {
    let rest = redirect.strip_prefix("http://127.0.0.1:").ok_or("This service signs in through a pasted address")?;
    let (port, path) = rest.split_once('/').ok_or("Invalid sign-in redirect")?;
    let port = port.parse::<u16>().map_err(|_| "Invalid sign-in redirect port")?;
    let path = format!("/{path}");
    if port < 1024 || path.contains(['?', '#']) || !matches!(path.as_str(), "/qobuz" | "/login") {
        return Err("Unexpected sign-in redirect".into());
    }
    Ok((port, path))
}

/// Starts waiting for the redirect to `redirect`, replacing any earlier wait.
pub async fn listen(redirect: &str) -> Result<()> {
    let (port, path) = parse(redirect)?;
    stop();
    *CAPTURED.lock().map_err(|_| "Sign-in lock failed")? = None;
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.map_err(|error| format!("Could not wait for the sign-in: {error}"))?;
    let task = tokio::spawn(async move {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15 * 60);
        loop {
            let Ok(Ok((mut stream, _))) = tokio::time::timeout_at(deadline, listener.accept()).await else { return };
            let mut buffer = vec![0_u8; 16 * 1024];
            let Ok(Ok(read)) = tokio::time::timeout(std::time::Duration::from_secs(10), stream.read(&mut buffer)).await else { continue };
            let request = String::from_utf8_lossy(&buffer[..read]);
            let target = request.lines().next().and_then(|line| line.strip_prefix("GET ")).and_then(|line| line.split(' ').next()).unwrap_or("");
            let matched = target == path || target.starts_with(&format!("{path}?"));
            let (status, body) = if matched { ("200 OK", PAGE) } else { ("404 Not Found", "") };
            let _ = stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
            if matched {
                if let Ok(mut captured) = CAPTURED.lock() {
                    *captured = Some(format!("http://127.0.0.1:{port}{target}"));
                }
                return;
            }
        }
    });
    *WAITING.lock().map_err(|_| "Sign-in lock failed")? = Some(Waiting { task });
    Ok(())
}

/// The callback, once the service has redirected to it.
pub fn result() -> Option<String> {
    CAPTURED.lock().ok()?.clone()
}

pub fn stop() {
    if let Ok(mut waiting) = WAITING.lock()
        && let Some(waiting) = waiting.take()
    {
        waiting.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_service_loopback_redirects_are_accepted() {
        assert_eq!(parse("http://127.0.0.1:8788/qobuz").unwrap(), (8788, "/qobuz".into()));
        assert_eq!(parse("http://127.0.0.1:5588/login").unwrap(), (5588, "/login".into()));
        assert!(parse("https://tidal.com/android/login/auth").is_err());
        assert!(parse("http://127.0.0.1:80/qobuz").is_err());
        assert!(parse("http://127.0.0.1:8788/elsewhere").is_err());
        assert!(parse("http://evil.example:8788/qobuz").is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_redirect_is_captured_with_its_code() {
        listen("http://127.0.0.1:47123/qobuz").await.unwrap();
        let mut stream = tokio::net::TcpStream::connect("127.0.0.1:47123").await.unwrap();
        stream.write_all(b"GET /qobuz?code_autorisation=abc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await.unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).await.unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert_eq!(result().as_deref(), Some("http://127.0.0.1:47123/qobuz?code_autorisation=abc"));
        stop();
    }
}
