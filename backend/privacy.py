"""Reject common sensitive-data patterns; never echo the matched value."""
import re
PATTERNS = (
    r"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}",
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b",
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    r"\b\d{6}[- ]?[1-4]\d{6}\b",
    r"\b01[016789][- .]?\d{3,4}[- .]?\d{4}\b",
    r"\b(?:\d[ -]?){13,19}\b",
)

def assert_safe(value):
    if isinstance(value, dict):
        for item in value.values():
            assert_safe(item)
    elif isinstance(value, list):
        for item in value:
            assert_safe(item)
    elif isinstance(value, str) and any(re.search(p, value, re.I) for p in PATTERNS):
        raise ValueError("Sensitive data is not permitted. Use pseudonymous IDs and team labels.")
