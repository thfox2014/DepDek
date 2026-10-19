//! Deployed, anonymous BitBay account routes (OPC0608-wechat public contract).
//! URL vocabulary only; authorization, user input and audit remain in Vault.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Endpoint { SendEmailCode, Register, Login }

impl Endpoint {
    pub(crate) const fn url(self) -> &'static str {
        match self {
            Self::SendEmailCode => "https://api.bitbay.site/v2/email/send-code",
            Self::Register => "https://api.bitbay.site/v2/user/register",
            Self::Login => "https://api.bitbay.site/v2/user/login",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_three_deployed_public_v2_endpoints_are_selectable() {
        for (endpoint, path) in [
            (Endpoint::SendEmailCode, "/v2/email/send-code"),
            (Endpoint::Register, "/v2/user/register"),
            (Endpoint::Login, "/v2/user/login"),
        ] {
            let url = url::Url::parse(endpoint.url()).unwrap();
            assert_eq!(url.scheme(), "https");
            assert_eq!(url.host_str(), Some("api.bitbay.site"));
            assert_eq!(url.path(), path);
            assert!(url.username().is_empty() && url.password().is_none());
            assert!(url.query().is_none() && url.fragment().is_none());
        }
    }
}
