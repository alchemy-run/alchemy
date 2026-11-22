/**
 * Certificates owned by the MtlsCertificate lookup tests. Cloudflare
 * rejects a second upload of identical content, so these are distinct from
 * the certificates other suites upload.
 *
 * Generated once with openssl (RSA-2048, 10-year validity) and checked in:
 *
 * ```sh
 * openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem \
 *   -days 3650 -subj "/CN=alchemy-mtls-lookup-managed-ca/O=Alchemy/C=US" \
 *   -addext "basicConstraints=critical,CA:TRUE" \
 *   -addext "keyUsage=critical,keyCertSign,cRLSign"
 * # the leaf is self-signed:
 * openssl req -x509 -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.pem \
 *   -days 3650 -subj "/CN=alchemy-mtls-lookup-target/O=Alchemy/C=US" \
 *   -addext "basicConstraints=critical,CA:FALSE" -addext "extendedKeyUsage=clientAuth"
 * ```
 */

/**
 * The self-signed client (leaf) certificate another stack uploads for the
 * lookup to find. A Worker binding needs a leaf with its private key.
 */
export const LOOKUP_TARGET_LEAF = `-----BEGIN CERTIFICATE-----
MIIDMDCCAhigAwIBAgIJAL/gssjAg6v4MA0GCSqGSIb3DQEBCwUAMEQxIzAhBgNV
BAMMGmFsY2hlbXktbXRscy1sb29rdXAtdGFyZ2V0MRAwDgYDVQQKDAdBbGNoZW15
MQswCQYDVQQGEwJVUzAeFw0yNjExMDQxODQ1MDJaFw0zNjExMDExODQ1MDJaMEQx
IzAhBgNVBAMMGmFsY2hlbXktbXRscy1sb29rdXAtdGFyZ2V0MRAwDgYDVQQKDAdB
bGNoZW15MQswCQYDVQQGEwJVUzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBAMjxpVjvEkMWb7RvHdHTNw/MKknCtzuV/dAjoJHXALTQRMo0JOlhuShM/cFk
EMNfZ5flm6zh9qCJHhKETlcokuG7E1O8MwNgkLVj11goKSZC5qp06LmaZ5kRzIG/
UwDkR1sYR2yApdcW8v7YIJxIrQCtKBzMHvNC4wzHoiO6xtlrFmj1tyOPVlQd29YV
Bm7xYUgX7JWrtFfSRkBjyDQuJp4/6f4yUAGmiEuz+zzADDVte+P/+2e0aR0OZyMZ
tmRg4E54R0+iuVy7ccJ0NBy9dJpuAHvGyQXBCK44lavswInb6iDcXP3Tv+mg6tkx
pJ853B5j5Xyd11ACFs9BMwmYxg8CAwEAAaMlMCMwDAYDVR0TAQH/BAIwADATBgNV
HSUEDDAKBggrBgEFBQcDAjANBgkqhkiG9w0BAQsFAAOCAQEAfRqhdACTeBWl9yMa
jJA+I9ylHCQ93p8EzD36sQ81/fJOlowSFgb2e4PObyvw+4zIIKery2gZiir0iugQ
Dtebjj7XdhZpNZwEYRj3WN+Enz+LIR0+opfXQOHaPKKHsqq9XSAsR7nlJmguDPv/
Dw2eaBm318HO+ls1VNxElDheIvyjmPFyGdPdMywNLUy7vgRLutZpbuPypqRD2Ka8
788mMpGIOhIe8ulLtX0j9+vDXSK+ZJDB4UlkB56LuaK9adzOIu/aiaI5IuTKrsBk
7O1HZ8hxlo48wtkVbAsNHq/roPmKDLMjEM+paldDJHIv3CtWraU6LJp4EFMW/wbH
QT5X1w==
-----END CERTIFICATE-----`;

export const LOOKUP_TARGET_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDI8aVY7xJDFm+0
bx3R0zcPzCpJwrc7lf3QI6CR1wC00ETKNCTpYbkoTP3BZBDDX2eX5Zus4fagiR4S
hE5XKJLhuxNTvDMDYJC1Y9dYKCkmQuaqdOi5mmeZEcyBv1MA5EdbGEdsgKXXFvL+
2CCcSK0ArSgczB7zQuMMx6IjusbZaxZo9bcjj1ZUHdvWFQZu8WFIF+yVq7RX0kZA
Y8g0LiaeP+n+MlABpohLs/s8wAw1bXvj//tntGkdDmcjGbZkYOBOeEdPorlcu3HC
dDQcvXSabgB7xskFwQiuOJWr7MCJ2+og3Fz907/poOrZMaSfOdweY+V8nddQAhbP
QTMJmMYPAgMBAAECggEAacci1l0LTPuLk/0GQoUgMBW2kRuKHzjG4oFOrlbyzTvx
akvmvmAt+vQEhIArft1DCCfbOje8/ycPCIpTPvhh0agL9YFVjUqRAptrKcICX1zK
ViKyu7l3HZHMCOTxSb/hfCecuZZDNqWjBto42Gw9feSo//fHtyCXqwuP46UXti0E
5nqn3wXOl0j/Mh59qGYej7cgcvLupI/7W2plDBIERO4d9+PS6cxgTqsX1y/LFZj6
yVVVG8LjPKd/3gCAPCLzaBf1N4kfkhyIHBYm4DOY/CGjk1J7Xqsatnk4M/vPTPRM
MLF6/y1T6Vr4OGMxYUJiKoov3mnIzfyxjQv30Ks7CQKBgQDw7lTM0XWfiuMkhvst
5tVnKEVjjEVtQJFJirsoSpCO/ztKKQSRrhBMbIOULr7vWOkxcRwnzu86/XNANF8V
onUSq2vCeM2SRSQ8JGXbUz6yV7ia9B2gWOeExsoMGezMYEIRheVy9HKjPt7EKQsI
XgaCoZuGd0Zrn/lHq/1lLrLjWwKBgQDVgw/CnbAnHAuVuRFuwNGFHnd97XsSrv26
cQkjxX/gx8LdVXVgA8MoJdYz2eSSS5+eIKPjYSVqrZ09pJpVCLBnz/oz6jhKNEj1
ZVEhs7owMob54YXNbnoP/dACE+r9HQa0L4DRtRR60hw3iZNy2jLEgauRtLSXRRvR
BF6UDVHqXQKBgQDc+AmIbFcvw0b+Olpmx/5ThUjWu1D1mbFmvLlYg8K/k/EB3ErX
fchu/1tSbekqReZiNTY4gH9DIC8y5JWMlxo+zD+h9f+8tnM8Qbm1hUzMbs3eOCRv
6voz+cpXfPOEoogV4DMH0pDNjhzr1iTLQMlByAyHMB/DF86eYGyf/0uMXwKBgFcJ
oncXiSOoTyCt3OllOQQnM1bmZHFtXImQYsVuUX70b/+CQuLtJbVMF1Hz1TW+FkeD
zst2YqZmN99VJoTbke3/3mMja+b0AXnn33b5qUDUmCltQfpIuwGh2hW+wOCF4KG7
a6wRQVQAKviI4M7FHET3B1XScHvp9Dj0qwl3lJkRAoGAI7PfWOcb1tGE+4EViC1q
5jCcbHOWllBYBlMw+HBU6cZz4F/wLXxkpayQKyWJJGBZqoVSqTZHkdamSTaV9P6S
ZkdKqy4WLwz+SflKMK+Q6jh0cfT/3Grq+W+X1Tj6AH+Kg8oaegwIEoIxdZQixRVu
AR9EhALvRt0a4X7emMFD4DE=
-----END PRIVATE KEY-----`;

/** The CA a lookup test uploads into its own stack. */
export const LOOKUP_MANAGED_CA = `-----BEGIN CERTIFICATE-----
MIIDNjCCAh6gAwIBAgIJALBUSdTy2UKOMA0GCSqGSIb3DQEBCwUAMEgxJzAlBgNV
BAMMHmFsY2hlbXktbXRscy1sb29rdXAtbWFuYWdlZC1jYTEQMA4GA1UECgwHQWxj
aGVteTELMAkGA1UEBhMCVVMwHhcNMjYxMTA0MTg0MzUxWhcNMzYxMTAxMTg0MzUx
WjBIMScwJQYDVQQDDB5hbGNoZW15LW10bHMtbG9va3VwLW1hbmFnZWQtY2ExEDAO
BgNVBAoMB0FsY2hlbXkxCzAJBgNVBAYTAlVTMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAwWZ7hsmgKHnEi+Ls8IRJ/OSRuzuueFJvbXjdAD+y2KyXtU0B
9IbJNbiWMxKVVjf+vMcQMGgZH4gmEkjWYVfHgDlR0sf6YoigBYDgq/V3SIBu4ZSQ
R/b3oHx04eB3t5yz3dNqEHlyV5zfDjeVJfP+oZWXsR/Hr+BNG/dBlqsBc7eVX/04
D798ZtGLRMX5q9gcdktcSG6d68liex3RIBy8YoYo6WM1gUnItSWB6Jx5WFwm36UK
GFGTWe0qV0C5fqTEOIxci5a37pm52JBprBisiehhuHdfxSR9/XHcWW7wLyp4I+7V
P+2Y7zXT+3JBX45+oe6TwYIzCbasMTpjwbnGNQIDAQABoyMwITAPBgNVHRMBAf8E
BTADAQH/MA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAQEACWJr6uCb
+5gJlHI8kM9NNnVHdh4kfMYqWdopdF6ptII9zFgkFn5qfdYXWG8oVONLVEVwqvx0
vOhW1QU9YtkSI6HwehCuuPLGo9Nqt5p1ZimnAz9g/8UA1QmS/PxPB1Q68H4upbof
+vmZocCN3yunpkOohqQEVBxtsJ1vwv1sxzeKftjl3hq6Wfz3LeTZVLvdG5ASSjUA
cDpM46ylBjLBX96wZdFSSrAnqrx5Hrifqb+uRXp9E2JLG2etuKm6xla137FWUXvd
1geC5+FgkstBKAu0hX2LYHUXAFHjnS2+UmElvo9Dbl7tfHSSr5f9x65PJXrZ7sNy
0kSusUCuWtOYNg==
-----END CERTIFICATE-----`;
