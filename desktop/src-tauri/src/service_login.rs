//! Provider pages get an isolated window. Only their exact redirect URL returns to the main app.
use reqwest::Url;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

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

#[tauri::command]
pub async fn open_service_login(
    app: tauri::AppHandle,
    window: WebviewWindow,
    provider: String,
    login_url: String,
    attempt_id: String,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("Only the main app may start service sign-in".into());
    }
    let (login, redirect) = login_redirect(&provider, &login_url)?;
    let label = label(&attempt_id)?;
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let navigation = sender.clone();
    // Async construction avoids WebView2's synchronous-command deadlock. Provider pages have no app capabilities.
    let browser = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(login))
        .title(format!(
            "Sign in to {} — Ambra",
            match provider.as_str() {
                "tidal" => "Tidal",
                "qobuz" => "Qobuz",
                _ => "Spotify",
            }
        ))
        .inner_size(560.0, 760.0)
        .incognito(true)
        .on_navigation(move |url| {
            if callback_matches(&redirect, url) {
                if let Some(sender) = navigation.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    let _ = sender.send(Ok(url.to_string()));
                }
                return false;
            }
            // Authentication pages may use HTTPS SSO, but may never navigate into app/file origins.
            url.scheme() == "https"
        })
        .build()
        .map_err(|_| "Could not open the service sign-in window")?;
    browser.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(sender) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
                let _ = sender.send(Err("Sign-in cancelled".into()));
            }
        }
    });
    let result = tokio::time::timeout(Duration::from_secs(600), receiver)
        .await
        .map_err(|_| "Sign-in timed out. Try again".to_owned())
        .and_then(|result| result.map_err(|_| "Sign-in window closed".to_owned()))
        .and_then(|result| result);
    let _ = browser.destroy();
    result
}

#[tauri::command]
pub async fn cancel_service_login(
    app: tauri::AppHandle,
    window: WebviewWindow,
    attempt_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main app may cancel service sign-in".into());
    }
    if let Some(browser) = app.get_webview_window(&label(&attempt_id)?) {
        let _ = browser.destroy();
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
