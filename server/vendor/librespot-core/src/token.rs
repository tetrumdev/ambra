// Ported from librespot-java. Relicensed under MIT with permission.

// Known scopes:
//   ugc-image-upload, playlist-read-collaborative, playlist-modify-private,
//   playlist-modify-public, playlist-read-private, user-read-playback-position,
//   user-read-recently-played, user-top-read, user-modify-playback-state,
//   user-read-currently-playing, user-read-playback-state, user-read-private, user-read-email,
//   user-library-modify, user-library-read, user-follow-modify, user-follow-read, streaming,
//   app-remote-control

use std::{
    fmt,
    time::{Duration, SystemTime},
};

use serde::Deserialize;
use thiserror::Error;

use crate::Error;

component! {
    TokenProvider : TokenProviderInner {
        tokens: Vec<Token> = vec![],
    }
}

#[derive(Debug, Error)]
pub enum TokenError {
    #[error("no tokens available")]
    Empty,
}

impl From<TokenError> for Error {
    fn from(err: TokenError) -> Self {
        Error::unavailable(err)
    }
}

#[derive(Clone)]
pub struct Token {
    pub access_token: String,
    pub expires_in: Duration,
    pub token_type: String,
    pub scopes: Vec<String>,
    pub timestamp: SystemTime,
}

impl fmt::Debug for Token {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Token")
            .field("access_token", &"[REDACTED]")
            .field("expires_in", &self.expires_in)
            .field("token_type", &self.token_type)
            .field("scopes", &self.scopes)
            .field("timestamp", &self.timestamp)
            .finish()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenData {
    access_token: String,
    expires_in: u64,
    token_type: String,
    scope: Vec<String>,
}

impl TokenProvider {
    fn find_token(&self, scopes: Vec<&str>) -> Option<usize> {
        self.lock(|inner| {
            (0..inner.tokens.len()).find(|&i| inner.tokens[i].in_scopes(scopes.clone()))
        })
    }

    // Not all combinations of scopes and client ID are allowed.
    // Depending on the client ID currently used, the function may return an error for specific scopes.
    // In this case get_token_with_client_id() can be used, where an appropriate client ID can be provided.
    // scopes must be comma-separated
    pub async fn get_token(&self, scopes: &str) -> Result<Token, Error> {
        let client_id = self.session().client_id();
        self.get_token_with_client_id(scopes, &client_id).await
    }

    pub async fn get_token_with_client_id(
        &self,
        scopes: &str,
        client_id: &str,
    ) -> Result<Token, Error> {
        if client_id.is_empty() {
            return Err(Error::invalid_argument("Client ID cannot be empty"));
        }

        if let Some(index) = self.find_token(scopes.split(',').collect()) {
            let cached_token = self.lock(|inner| inner.tokens[index].clone());
            if cached_token.is_expired() {
                self.lock(|inner| inner.tokens.remove(index));
            } else {
                return Ok(cached_token);
            }
        }

        trace!(
            "Requested token in scopes {scopes:?} unavailable or expired, requesting new token."
        );

        let query_uri = format!(
            "hm://keymaster/token/authenticated?scope={}&client_id={}&device_id={}",
            scopes,
            client_id,
            self.session().device_id(),
        );
        let request = self.session().mercury().get(query_uri)?;
        let response = request.await?;
        let data = response.payload.first().ok_or(TokenError::Empty)?.to_vec();
        // Utf8Error does not retain the credential-bearing response bytes.
        let token = Token::from_json(std::str::from_utf8(&data)?.to_owned())?;
        self.lock(|inner| inner.tokens.push(token.clone()));
        Ok(token)
    }
}

impl Token {
    const EXPIRY_THRESHOLD: Duration = Duration::from_secs(10);

    pub fn from_json(body: String) -> Result<Self, Error> {
        // Serde data errors can quote response values. Keep only safe location data.
        let data: TokenData = serde_json::from_slice(body.as_ref()).map_err(|error| {
            Error::failed_precondition(format!(
                "invalid token response JSON at line {} column {}",
                error.line(),
                error.column()
            ))
        })?;
        Ok(Self {
            access_token: data.access_token,
            expires_in: Duration::from_secs(data.expires_in),
            token_type: data.token_type,
            scopes: data.scope,
            timestamp: SystemTime::now(),
        })
    }

    pub fn is_expired(&self) -> bool {
        self.timestamp + self.expires_in.saturating_sub(Self::EXPIRY_THRESHOLD) < SystemTime::now()
    }

    pub fn in_scope(&self, scope: &str) -> bool {
        for s in &self.scopes {
            if *s == scope {
                return true;
            }
        }
        false
    }

    pub fn in_scopes(&self, scopes: Vec<&str>) -> bool {
        for s in scopes {
            if !self.in_scope(s) {
                return false;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "spotify-secret-regression-sentinel";

    #[test]
    fn token_debug_redacts_access_token() {
        let token = Token::from_json(format!(
            r#"{{"accessToken":"{SECRET}","expiresIn":3600,"tokenType":"Bearer","scope":["streaming"]}}"#
        ))
        .unwrap();
        assert_eq!(token.access_token, SECRET);
        assert!(token.in_scope("streaming"));
        assert!(!token.is_expired());
        for output in [format!("{token:?}"), format!("{token:#?}")] {
            assert!(!output.contains(SECRET), "token leaked through Debug");
            assert!(output.contains("[REDACTED]"));
        }
    }

    #[test]
    fn token_parse_errors_do_not_retain_response_values() {
        for body in [
            format!(
                r#"{{"accessToken":"{SECRET}","expiresIn":"{SECRET}","tokenType":"Bearer","scope":[]}}"#
            ),
            format!(
                r#"{{"accessToken":"{SECRET}","expiresIn":3600,"tokenType":"Bearer","scope":"{SECRET}"}}"#
            ),
            format!(r#""{SECRET}""#),
        ] {
            let error = Token::from_json(body).unwrap_err();
            assert_eq!(error.kind, crate::error::ErrorKind::FailedPrecondition);
            for output in [
                format!("{error}"),
                format!("{error:?}"),
                format!("{error:#?}"),
            ] {
                assert!(
                    !output.contains(SECRET),
                    "token response leaked through error"
                );
            }
            assert!(std::error::Error::source(&error).is_none());
        }
    }
}
