"""Test-only OIDC verifier; production uses GoogleOidcVerifier."""
class FakeOidcVerifier:
    def __init__(self, valid_tokens: set[str] | None = None) -> None:
        self.valid_tokens = valid_tokens or {"valid"}
    def verify(self, token: str, audience: str) -> bool:
        return token in self.valid_tokens and bool(audience)
