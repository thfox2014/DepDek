//! The platform contract is sourced from OPC0608-wechat, not inferred domains.
//! Fixed endpoints only. No tokens/cookies or remote error text leave this module.
use crate::secrets::SecretText;
use crate::bitbay_public_api::Endpoint;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::time::Duration;
use zeroize::Zeroizing;

const MAX_RESPONSE: u64 = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("BITBAY_EMAIL_INVALID")] Email,
    #[error("BITBAY_CODE_INVALID")] Code,
    #[error("BITBAY_PASSWORD_INVALID")] Password,
    #[error("BITBAY_RATE_LIMITED")] RateLimited,
    #[error("BITBAY_ALREADY_REGISTERED")] AlreadyRegistered,
    #[error("BITBAY_LOGIN_FAILED")] Login,
    #[error("BITBAY_UNAVAILABLE")] Unavailable,
    #[error("BITBAY_OUTCOME_UNKNOWN")] Unknown,
    #[error("BITBAY_REQUEST_REJECTED")] Rejected,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Account { pub email: String, pub user_id: u64 }

pub fn normalize_email(value: &str) -> Result<String, Error> {
    let value = value.trim().to_ascii_lowercase();
    // Plain mailbox only: reject display names, controls, URLs and ambiguous input.
    let (local, domain) = value.split_once('@').ok_or(Error::Email)?;
    if value.len() > 254 || local.is_empty() || local.len() > 64 || domain.len() > 253
        || !local.bytes().all(|b| b.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~".contains(&b))
        || local.starts_with('.') || local.ends_with('.') || local.contains("..")
        || !domain.contains('.') || domain.split('.').any(|label| label.is_empty() || label.len() > 63
            || label.starts_with('-') || label.ends_with('-')
            || !label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
    { return Err(Error::Email); }
    Ok(value)
}

pub fn validate_password(password: &SecretText, registering: bool) -> Result<(), Error> {
    let minimum = if registering { 12 } else { 6 };
    if !(minimum..=20).contains(&password.bytes().len()) || password.bytes().iter().any(u8::is_ascii_control) {
        return Err(Error::Password);
    }
    Ok(())
}

#[derive(Deserialize)]
struct Reply {
    code: i64,
    // Do not deserialize arbitrary server message, token or Matrix fields.
    data: Option<ReplyData>,
}
#[derive(Deserialize)]
struct ReplyData {
    #[serde(rename = "userId")] user_id: Option<u64>,
    username: Option<String>,
}

fn parse_reply(status: u16, body: &[u8], email: &str, login: bool) -> Result<Option<Account>, Error> {
    if body.len() > MAX_RESPONSE as usize { return Err(Error::Unknown); }
    // Send-code can return arbitrary data in dev mode; never expose that code.
    let value: serde_json::Value = serde_json::from_slice(body).map_err(|_| Error::Unknown)?;
    let code = value.get("code").and_then(|v| v.as_i64()).ok_or(Error::Unknown)?;
    if !(200..300).contains(&status) || code != 0 {
        let effective = if code != 0 { code } else { i64::from(status) };
        return Err(match effective {
            429 => Error::RateLimited, 409 => Error::AlreadyRegistered,
            401 | 403 => Error::Login, 400 => if login { Error::Rejected } else { Error::Code },
            500..=599 => Error::Unavailable, _ => Error::Rejected,
        });
    }
    if email.is_empty() { return Ok(None); }
    let reply: Reply = serde_json::from_slice(body).map_err(|_| Error::Unknown)?;
    let data = reply.data.ok_or(Error::Unknown)?;
    let user_id = data.user_id.filter(|id| *id > 0).ok_or(Error::Unknown)?;
    if reply.code != 0 || login && data.username.as_deref().and_then(|name| normalize_email(name).ok()).as_deref() != Some(email) {
        return Err(Error::Unknown);
    }
    Ok(Some(Account { email: email.into(), user_id }))
}

fn post<T: Serialize>(endpoint: Endpoint, input: &T, email: &str, login: bool) -> Result<Option<Account>, Error> {
    let client = reqwest::blocking::Client::builder()
        .no_proxy().https_only(true).redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never()).connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15)).build().map_err(|_| Error::Unavailable)?;
    let response = client.post(endpoint.url()).json(input).send().map_err(|_| Error::Unknown)?;
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|size| size > MAX_RESPONSE) { return Err(Error::Unknown); }
    let mut bytes = Zeroizing::new(Vec::new());
    response.take(MAX_RESPONSE + 1).read_to_end(&mut bytes).map_err(|_| Error::Unknown)?;
    parse_reply(status, &bytes, email, login)
}

pub fn send_code(email: &str) -> Result<(), Error> {
    #[derive(Serialize)] struct Input<'a> { email: &'a str }
    post(Endpoint::SendEmailCode, &Input { email }, "", false).map(|_| ())
}
pub fn register(email: &str, password: &SecretText, code: Option<&SecretText>) -> Result<Account, Error> {
    let code = code.ok_or(Error::Code)?;
    if code.bytes().len() != 6 || !code.bytes().iter().all(u8::is_ascii_digit) { return Err(Error::Code); }
    #[derive(Serialize)] struct Input<'a> { email: &'a str, password: &'a SecretText, code: &'a SecretText }
    post(Endpoint::Register, &Input { email, password, code }, email, false)?.ok_or(Error::Unknown)
}
pub fn login(email: &str, password: &SecretText, _code: Option<&SecretText>) -> Result<Account, Error> {
    #[derive(Serialize)] struct Input<'a> { username: &'a str, password: &'a SecretText }
    post(Endpoint::Login, &Input { username: email, password }, email, true)?.ok_or(Error::Unknown)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_plain_email_password_and_code_without_sending_requests() {
        assert_eq!(normalize_email("  TEST+photo@Example.com ").unwrap(), "test+photo@example.com");
        for value in ["", "a@b", "x@y@z.com", "Name <a@b.com>", "x\n@y.com", "a@-bad.com", "..a@b.com", "a@b..com"] { assert!(normalize_email(value).is_err(), "{value}"); }
        for value in ["short", "123456789012345678901", "password\n12345"] { assert!(validate_password(&SecretText::new(value.into()), true).is_err()); }
        assert!(validate_password(&SecretText::new("TestPassword2026!".into()), true).is_ok());
        assert!(matches!(register("a@b.com", &SecretText::new("Synthetic2026!".into()), Some(&SecretText::new("abc123".into()))), Err(Error::Code)));
    }
    #[test]
    fn accepts_only_successful_verified_identity_and_discards_platform_secrets() {
        let reply = br#"{"code":0,"data":{"userId":9,"username":"A@b.com","token":"synthetic-sensitive","matrixToken":"synthetic-matrix"}}"#;
        let account = parse_reply(200, reply, "a@b.com", true).unwrap().unwrap();
        assert_eq!(account.user_id, 9);
        let public = serde_json::to_string(&account).unwrap();
        assert!(!public.contains("synthetic") && !public.contains("token"));
        assert!(parse_reply(200, reply, "other@b.com", true).is_err());
        for body in [br#"{"code":0}"#.as_slice(), br#"{"data":{"userId":9}}"#, br#"{"code":0,"data":{"userId":0}}"#, br#"{"code":0,"data":{"userId":"9"}}"#, b"<html>login</html>"] {
            assert!(parse_reply(200, body, "a@b.com", false).is_err());
        }
        assert!(parse_reply(200, &vec![b' '; MAX_RESPONSE as usize + 1], "", false).is_err());
    }
    #[test]
    fn error_messages_and_development_codes_are_never_reflected() {
        for (status, body) in [(429, br#"{"code":429,"message":"secret"}"#.as_slice()), (409, br#"{"code":409,"message":"secret"}"#), (400, br#"{"code":400,"message":"secret"}"#)] {
            let error = parse_reply(status, body, "a@b.com", false).err().unwrap().to_string();
            assert!(error.starts_with("BITBAY_") && !error.contains("secret"));
        }
        assert!(parse_reply(200, br#"{"code":0,"data":{"code":"123456"}}"#, "", false).unwrap().is_none());
        assert!(parse_reply(302, br#"{"code":0,"data":{"userId":9}}"#, "a@b.com", false).is_err());
    }
    #[test]
    #[ignore = "explicit public-API validation smoke; sends only empty JSON, no account data"]
    fn live_public_account_routes_reject_empty_input_without_creating_accounts() {
        let empty = serde_json::json!({});
        assert!(matches!(post(Endpoint::SendEmailCode, &empty, "", false), Err(Error::Code)));
        assert!(matches!(post(Endpoint::Register, &empty, "", false), Err(Error::Code)));
        assert!(matches!(post(Endpoint::Login, &empty, "", true), Err(Error::Rejected)));
    }
}
