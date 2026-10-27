//! Pending browser sign-ins belong to one paired device and expire without storing credentials.
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use sha2::{Digest, Sha256};
use std::{
    io,
    time::{Duration, Instant},
};

pub fn random_secret() -> Result<String, io::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(io::Error::other)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub struct PendingLogin<T> {
    pub id: String,
    pub owner: Option<String>,
    started: Instant,
    redirect: Url,
    pub login: T,
}

impl<T> PendingLogin<T> {
    pub fn new(login: T, login_url: &str, owner: Option<String>) -> Result<Self, String> {
        let url = Url::parse(login_url).map_err(|_| "Invalid service sign-in URL")?;
        let redirect = url
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri" || key == "redirect_url")
            .and_then(|(_, value)| Url::parse(&value).ok())
            .ok_or("Missing service sign-in redirect")?;
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| "Could not create a sign-in attempt")?;
        Ok(Self {
            id: bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
            owner,
            started: Instant::now(),
            redirect,
            login,
        })
    }

    pub fn check(&self, owner: &Option<String>, attempt_id: Option<&str>) -> Result<(), String> {
        if self.started.elapsed() >= Duration::from_secs(600) {
            return Err("Sign-in expired. Start again".into());
        }
        if &self.owner != owner
            || attempt_id.is_some_and(|id| id != self.id)
            || (owner.is_some() && attempt_id.is_none())
        {
            return Err("This sign-in belongs to another attempt or device".into());
        }
        Ok(())
    }

    pub fn validate_callback(&self, callback: &str) -> Result<(), String> {
        let url = Url::parse(callback).map_err(|_| "Invalid service callback URL")?;
        if self.redirect.scheme() != url.scheme()
            || self.redirect.host_str() != url.host_str()
            || self.redirect.port_or_known_default() != url.port_or_known_default()
            || self.redirect.path() != url.path()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err("This callback is not for the selected service".into());
        }
        if url.query_pairs().any(|(key, _)| key == "error") {
            return Err("Service sign-in was declined".into());
        }
        Ok(())
    }
}

pub fn ensure_available<T>(
    pending: &Option<PendingLogin<T>>,
    owner: &Option<String>,
) -> Result<(), String> {
    if pending.as_ref().is_some_and(|login| {
        login.started.elapsed() < Duration::from_secs(600) && &login.owner != owner
    }) {
        return Err("Another device is signing in to this service. Try again shortly".into());
    }
    Ok(())
}

pub struct SpotifyLogin {
    verifier: String,
    state: String,
    pub client_id: String,
    pub redirect: String,
}

impl SpotifyLogin {
    pub fn new(client_id: String, port: u16) -> Result<(Self, String), io::Error> {
        let verifier = random_secret()?;
        let state = random_secret()?;
        let redirect = format!("http://127.0.0.1:{port}/login");
        let mut url = Url::parse("https://accounts.spotify.com/authorize").unwrap();
        url.query_pairs_mut().extend_pairs([
            ("client_id", client_id.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("response_type", "code"),
            ("scope", "streaming user-read-private"),
            ("state", state.as_str()),
            ("code_challenge_method", "S256"),
            (
                "code_challenge",
                URL_SAFE_NO_PAD
                    .encode(Sha256::digest(verifier.as_bytes()))
                    .as_str(),
            ),
        ]);
        Ok((
            Self {
                verifier,
                state,
                client_id,
                redirect,
            },
            url.to_string(),
        ))
    }

    pub fn exchange_fields(&self, callback: &str) -> Result<Vec<(&str, String)>, io::Error> {
        let url = Url::parse(callback).map_err(|_| io::Error::other("Invalid Spotify callback"))?;
        let pairs = url.query_pairs().collect::<Vec<_>>();
        let unique = |name: &str| {
            let values = pairs
                .iter()
                .filter(|(key, _)| key == name)
                .collect::<Vec<_>>();
            (values.len() == 1).then(|| values[0].1.to_string())
        };
        if unique("state").as_deref() != Some(&self.state) {
            return Err(io::Error::other("Spotify sign-in state did not match"));
        }
        let code = unique("code")
            .filter(|code| !code.is_empty())
            .ok_or_else(|| io::Error::other("Spotify returned no authorization code"))?;
        Ok(vec![
            ("grant_type", "authorization_code".into()),
            ("client_id", self.client_id.clone()),
            ("redirect_uri", self.redirect.clone()),
            ("code_verifier", self.verifier.clone()),
            ("code", code),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_attempts_are_bound_to_device_id_attempt_id_and_callback() {
        let owner = Some("phone".to_owned());
        let pending = PendingLogin::new(
            (),
            "https://www.qobuz.com/signin/oauth?redirect_url=http%3A%2F%2F127.0.0.1%3A8788%2Fqobuz",
            owner.clone(),
        )
        .unwrap();
        assert!(pending.check(&owner, Some(&pending.id)).is_ok());
        assert!(
            pending
                .check(&Some("other".into()), Some(&pending.id))
                .is_err()
        );
        assert!(pending.check(&owner, Some("old-attempt")).is_err());
        assert!(pending.check(&owner, None).is_err());
        assert!(
            pending
                .validate_callback("http://127.0.0.1:8788/qobuz?code_autorisation=x")
                .is_ok()
        );
        assert!(
            pending
                .validate_callback("http://attacker.test/qobuz?code=x")
                .is_err()
        );
    }
    #[test]
    fn spotify_pkce_and_state_are_fresh_and_validated_without_logging_codes() {
        let (login, url) = SpotifyLogin::new("client".into(), 8898).unwrap();
        let parsed = Url::parse(&url).unwrap();
        let state = parsed
            .query_pairs()
            .find(|(key, _)| key == "state")
            .unwrap()
            .1
            .into_owned();
        let fields = login
            .exchange_fields(&format!(
                "http://127.0.0.1:8898/login?code=test&state={state}"
            ))
            .unwrap();
        assert_eq!(
            fields
                .iter()
                .find(|(key, _)| *key == "code_verifier")
                .unwrap()
                .1,
            login.verifier
        );
        assert!(
            login
                .exchange_fields("http://127.0.0.1:8898/login?code=test&state=wrong")
                .is_err()
        );
        assert!(
            login
                .exchange_fields(&format!(
                    "http://127.0.0.1:8898/login?code=test&state={state}&state={state}"
                ))
                .is_err()
        );
        assert_ne!(url, SpotifyLogin::new("client".into(), 8898).unwrap().1);
    }

    #[test]
    fn expired_attempts_release_the_provider_without_accepting_late_completions() {
        let mut pending = Some(PendingLogin::new((), "https://accounts.spotify.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8898%2Flogin", Some("first".into())).unwrap());
        assert!(ensure_available(&pending, &Some("second".into())).is_err());
        let login = pending.as_mut().unwrap();
        login.started = Instant::now() - Duration::from_secs(601);
        assert!(login.check(&Some("first".into()), Some(&login.id)).is_err());
        assert!(ensure_available(&pending, &Some("second".into())).is_ok());
    }
}
