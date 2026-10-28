//! Sign in with the default browser; capture loopback redirects on this computer.
use reqwest::Url;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::Duration,
};
use tauri::WebviewWindow;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::oneshot,
};

fn login_redirect(provider: &str, source: &str) -> Result<(Url, Url), String> {
    let login = Url::parse(source).map_err(|_| "Invalid service sign-in URL")?;
    let trusted = login.scheme() == "https"
        && login.username().is_empty()
        && login.password().is_none()
        && login.port_or_known_default() == Some(443)
        && match provider {
            "tidal" => login.host_str() == Some("login.tidal.com") && login.path() == "/authorize",
            "qobuz" => login.host_str() == Some("www.qobuz.com") && login.path() == "/signin/oauth",
            "spotify" => {
                login.host_str() == Some("accounts.spotify.com") && login.path() == "/authorize"
            }
            _ => false,
        };
    if !trusted {
        return Err("This is not a trusted service sign-in URL".into());
    }
    let redirect = login
        .query_pairs()
        .find(|(key, _)| key == "redirect_uri" || key == "redirect_url")
        .and_then(|(_, value)| Url::parse(&value).ok())
        .ok_or("The service sign-in has no redirect URL")?;
    let allowed = match provider {
        "tidal" => redirect.as_str() == "https://tidal.com/android/login/auth",
        "qobuz" => redirect.as_str() == "http://127.0.0.1:8788/qobuz",
        "spotify" => {
            redirect.scheme() == "http"
                && redirect.host_str() == Some("127.0.0.1")
                && redirect.port().is_some()
                && redirect.path() == "/login"
                && redirect.query().is_none()
        }
        _ => false,
    };
    if !allowed
        || !redirect.username().is_empty()
        || redirect.password().is_some()
        || redirect.fragment().is_some()
    {
        return Err("Unexpected service sign-in redirect".into());
    }
    Ok((login, redirect))
}

fn callback_matches(target: &Url, url: &Url) -> bool {
    target.scheme() == url.scheme()
        && target.host_str() == url.host_str()
        && target.port_or_known_default() == url.port_or_known_default()
        && target.path() == url.path()
        && url.username().is_empty()
        && url.password().is_none()
        && url
            .query_pairs()
            .any(|(key, _)| matches!(key.as_ref(), "code" | "code_autorisation" | "error"))
}

fn label(attempt_id: &str) -> Result<String, String> {
    if attempt_id.len() != 32 || !attempt_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid sign-in attempt".into());
    }
    Ok(format!("service-login-{attempt_id}"))
}

struct LoginAttempt {
    redirect: Url,
    sender: oneshot::Sender<Result<String, String>>,
}

static ATTEMPTS: LazyLock<Mutex<HashMap<String, LoginAttempt>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct AttemptGuard(String);
impl Drop for AttemptGuard {
    fn drop(&mut self) {
        ATTEMPTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

async fn browser_callback(
    listener: TcpListener,
    login: &Url,
    redirect: &Url,
) -> Result<String, String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| "Could not receive service sign-in")?;
        let request = tokio::time::timeout(Duration::from_secs(5), async {
            let mut request = Vec::new();
            let mut buffer = [0; 1024];
            while request.len() < 8192 {
                let count = stream.read(&mut buffer).await.ok()?;
                if count == 0 {
                    return None;
                }
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|part| part == b"\r\n\r\n") {
                    return String::from_utf8(request).ok();
                }
            }
            None
        })
        .await
        .ok()
        .flatten();
        let callback = request.as_deref().and_then(|request| {
            let mut line = request.lines().next()?.split_whitespace();
            if line.next()? != "GET" {
                return None;
            }
            let host = request
                .lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .find(|(name, _)| name.eq_ignore_ascii_case("host"))?
                .1
                .trim();
            let expected_host = format!("127.0.0.1:{}", redirect.port()?);
            if host != expected_host {
                return None;
            }
            let path = line.next()?;
            if !path.starts_with('/') || path.starts_with("//") {
                return None;
            }
            let url = Url::parse(&format!(
                "{}{}",
                redirect.origin().ascii_serialization(),
                path
            ))
            .ok()?;
            if !callback_matches(redirect, &url) {
                return None;
            }
            // Spotify binds the authorization to its original PKCE attempt.
            if let Some((_, state)) = login.query_pairs().find(|(key, _)| key == "state") {
                let states: Vec<_> = url
                    .query_pairs()
                    .filter(|(key, _)| key == "state")
                    .collect();
                if states.len() != 1 || states[0].1 != state {
                    return None;
                }
            }
            Some(url.to_string())
        });
        let (status, message) = if callback.is_some() {
            (
                "200 OK",
                "Sign-in response received. Return to Ambra to finish connecting. You can close this tab.",
            )
        } else {
            (
                "400 Bad Request",
                "This is not the expected sign-in response. Return to the service tab to finish signing in.",
            )
        };
        let body = format!(
            "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Ambra sign-in</title><body><p>{message}</p></body></html>"
        );
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            stream.write_all(response.as_bytes()).await?;
            stream.shutdown().await
        })
        .await;
        if let Some(callback) = callback {
            return Ok(callback);
        }
    }
}

#[tauri::command]
pub async fn open_service_login(
    window: WebviewWindow,
    provider: String,
    login_url: String,
    attempt_id: String,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Only the main app may start service sign-in".into());
    }
    let (login, redirect) = login_redirect(&provider, &login_url)?;
    let key = label(&attempt_id)?;
    // Bind before opening the browser so a fast redirect cannot race the listener.
    let listener = if redirect.scheme() == "http" {
        Some(TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, redirect.port().unwrap()))
            .await.map_err(|_| "The service sign-in port is in use. Close other sign-in attempts and try again")?)
    } else {
        None
    };
    let (sender, receiver) = oneshot::channel();
    {
        let mut attempts = ATTEMPTS.lock().unwrap_or_else(|e| e.into_inner());
        if attempts.contains_key(&key) {
            return Err("This sign-in is already open".into());
        }
        attempts.insert(
            key.clone(),
            LoginAttempt {
                redirect: redirect.clone(),
                sender,
            },
        );
    }
    let _guard = AttemptGuard(key);
    tauri_plugin_opener::open_url(login.as_str(), None::<&str>)
        .map_err(|_| "Could not open the default browser")?;
    let result = tokio::time::timeout(Duration::from_secs(600), async {
        let manual = async { receiver.await.map_err(|_| "Sign-in cancelled".to_owned())? };
        match listener {
            Some(listener) => tokio::select! {
                result = browser_callback(listener, &login, &redirect) => result,
                result = manual => result,
            },
            None => manual.await,
        }
    })
    .await
    .map_err(|_| "Sign-in timed out. Try again".to_owned())?;
    if result.is_ok() {
        let _ = window.show();
        let _ = window.set_focus();
    }
    result
}

/// Tidal's registered HTTPS callback belongs to Tidal, so it cannot reach a loopback listener.
#[tauri::command]
pub async fn submit_service_login(
    window: WebviewWindow,
    attempt_id: String,
    callback_url: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main app may complete service sign-in".into());
    }
    let key = label(&attempt_id)?;
    let callback = Url::parse(callback_url.trim())
        .map_err(|_| "Paste the full callback URL from your browser")?;
    let mut attempts = ATTEMPTS.lock().unwrap_or_else(|e| e.into_inner());
    let attempt = attempts
        .get(&key)
        .ok_or("This sign-in is no longer active")?;
    if attempt.redirect.scheme() != "https" || !callback_matches(&attempt.redirect, &callback) {
        return Err("This URL is not the expected service callback".into());
    }
    let attempt = attempts.remove(&key).unwrap();
    attempt
        .sender
        .send(Ok(callback.to_string()))
        .map_err(|_| "This sign-in is no longer active".into())
}

#[tauri::command]
pub async fn cancel_service_login(window: WebviewWindow, attempt_id: String) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main app may cancel service sign-in".into());
    }
    if let Some(attempt) = ATTEMPTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&label(&attempt_id)?)
    {
        let _ = attempt.sender.send(Err("Sign-in cancelled".into()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_provider_pages_and_redirects_are_accepted() {
        let (_, redirect) = login_redirect("tidal", "https://login.tidal.com/authorize?redirect_uri=https%3A%2F%2Ftidal.com%2Fandroid%2Flogin%2Fauth").unwrap();
        assert!(callback_matches(
            &redirect,
            &Url::parse("https://tidal.com/android/login/auth?code=secret").unwrap()
        ));
        for url in [
            "https://tidal.com.attacker.test/android/login/auth?code=x",
            "https://tidal.com/android/login/auth/extra?code=x",
            "https://tidal.com/android/login/auth",
            "http://tidal.com/android/login/auth?code=x",
        ] {
            assert!(!callback_matches(&redirect, &Url::parse(url).unwrap()));
        }
        for url in [
            "file:///tmp/login",
            "https://attacker.test/authorize",
            "https://login.tidal.com/authorize?redirect_uri=file%3A%2F%2F%2Ftmp%2Flogin",
        ] {
            assert!(login_redirect("tidal", url).is_err());
        }
        assert!(login_redirect("qobuz", "https://www.qobuz.com/signin/oauth?redirect_url=http%3A%2F%2F127.0.0.1%3A8788%2Fqobuz").is_ok());
        assert!(login_redirect("spotify", "https://accounts.spotify.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8898%2Flogin").is_ok());
        assert!(label("../../main").is_err());
    }
}
