/**
 * Deterministic test keys for CertRequest tests.
 *
 * Generated once with `node:crypto` (`generateKeyPairSync`, PKCS#8 PEM) and
 * checked in so every test run signs with identical keys. They are for tests
 * only. Nothing trusts them.
 */

export const RSA_2048_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCg/IauH1vWmE01
ezoXLbYokIkfJQMyqsMJ6WpPQGF8efrtModA6SqHdr/pDcndKtLnE2lvxdMLqpGJ
Tp0R+PlBe6JuMU59373/rQYTWuNZSNy//Zulfn0HtwGfHzWi6q6qlvCMJKK1PnFp
XLLKl7WzS1LxlFrjENq3g+WMs9/u3Z7NHMvVeSkKZ8k9PUqMy/cW+k3kcTWvCqip
P6m52oC7yIB83kApFzVw22YYAeycpL0uyUTcqJn0PfczP/N7omGGXM6Qf9WtDksL
gkkNEIl6XWt455YsvYgZQ+HxEcaSnrO0MQ2Qe6Jl5GGhy9ztR6ggzM6r8ANk8SlL
4mYXpVmJAgMBAAECggEAT5LC14p0kKwTbd4NJqvXoFFhFd3rqL2zTlDr1WSTSz3Y
BCq3pCQce3z8+ytvnjyupr13nmIAIYIcEeyjwuB4BCAid6kzjRBtD9XsbOC+A8H6
K4QlzTWqg4e363k3v+GUmImnOP5a1o+Y62WAkpdOnuMaioK0MgyAr7koW9YFWEG2
C+lD5kBB+ISj3oQZeKf90XSpaQu1mpoeosZrrh3hq3FIDYFz7kvP1P5yIPH49ox0
QG+9HPLxtCebV3gm67OSchzyEuY3qdvsMOkRDEuxoSJtIea4ji4LR2bxJOGRfvel
pCD4Wi6TP8a2/n1c+gsaQaYjkWE+j0fD876bHwFgqQKBgQDbxr1vr6Ba4bK2Ytjs
MwMN4xBPMF2fRHMu7K8okGEz9c8G7FPq8tB7asupiNLwEeC2eMoX5qTea5AXmBgY
z5nIK4sWbM9+CzIeweUglgCig7sUZg5UaM1pljXINNQwC0Quo48B67rc55R1pJ1v
1bDcvyrUseqiCWb3OUGKj0w6KwKBgQC7hTNP0s3ZtOV3ehcMdP1516NqwF1AWoEF
p5khdMImDjKZfDv9bkrqAKNVk39jpv+vbS5v9GLcLd3o+F01ypDTGCgoU8xUR+ox
JicHY7HUPkeRUF1KpBHOBPlDw2URIH+0f61HgVt+ts0MDHJQhUst19KFYlB87xCY
TlIn2BklGwKBgE02sL15dZwYaYI8jjvF3E/Xs5YuxuW61cDptMxKlWv882RaSU1l
S6vgpHcGtB1WGp3hKBdnmArwvWocrHKjFUNHURFq3ydIZa56rrZZHRX7tBGBnY04
WNq8xF53eQj8HFNKcWbaXAdacUU3tXxiFkYn/7NEYsvVA9Dd09ILcFuLAoGAUVUH
mWKcSAXO1RBOOOfxHMyro1yF1aird1Fm+HzUzH6x8aJRvqz8rxvRvAc6ZHWFRog7
cPF1g3wdWLOIchFG2VgL6tnVsOR0LhcXLHxQH/dXQS6zF/Gri0ja+EoiZthKq3YJ
KQ9xKLeOneA0ILp/jgWi2Jl4wYdLElQ+C+wNk+sCgYBl3b8GX+qYOHF9mIZHLkGv
RtfPOlIfdrBWz7mtanBExgkqRQ36T4IyJsYFPzyBkf5+1YWX6soARBWg9CzVIRbh
H96VesjFY7j3mBfVkj17tBdA8Z00XZGtQ8akxVN0Ga6ZDVb9oj5bwCYYinUaj04D
8u/nsRvTebH2ZipVDIEyWg==
-----END PRIVATE KEY-----
`;

export const EC_P256_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgftj5gGHomByW2gqW
iU2kKmJfxOiVo5vqAB7OqsDa3bChRANCAARUjtwovJlRmRNSFJgv6rkWmWl+tqu2
mYRhwUfUzH3sNeGQrhISnurUhToyk4tpKWRVIjA4z7+jxRYkUtkjtzpw
-----END PRIVATE KEY-----
`;

/** A second P-256 key, for key-rotation tests. */
export const EC_P256_KEY_2 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgqWA0NHFOCHpkeoVy
j5H4fRK+FNALM2DZRDjw4L7OWI6hRANCAAToGKb4FQ0MxSUGwyuYEReFiry/ZrAK
Mf103z1T6JOnMXyebncOJAjxWU3CSfi0/3LQwNTzItrFoEfEabwS352v
-----END PRIVATE KEY-----
`;

export const ED25519_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIN9r5CPFAbkMTJ31W4b9/LW4PB6krWvZaQRBNBeOQgFQ
-----END PRIVATE KEY-----
`;

/** X25519 is a key-agreement key: it cannot sign, so CertRequest rejects it. */
export const X25519_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VuBCIEIAARwlyJiQ4kSnowW2br0Qwjydl3Iu+otdqrsI++clN3
-----END PRIVATE KEY-----
`;
