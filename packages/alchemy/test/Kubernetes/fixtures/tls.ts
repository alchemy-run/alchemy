/**
 * A self-signed TLS identity for a fake Kubernetes API server on
 * `https://127.0.0.1` (the internal client only speaks HTTPS).
 *
 * Generated once with LibreSSL and checked in (P-256, 10-year validity):
 *
 * ```sh
 * openssl ecparam -name prime256v1 -genkey -noout -out key.pem
 * openssl req -new -x509 -key key.pem -out cert.pem -days 3650 \
 *   -subj "/CN=127.0.0.1/O=Alchemy Test" \
 *   -addext "subjectAltName=IP:127.0.0.1"
 * ```
 */

/** Self-signed certificate for `IP:127.0.0.1` (expires 2036). */
export const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIBXzCCAQagAwIBAgIJAInPYaQmtngdMAoGCCqGSM49BAMCMCsxEjAQBgNVBAMM
CTEyNy4wLjAuMTEVMBMGA1UECgwMQWxjaGVteSBUZXN0MB4XDTI2MDkyNTA3Mjgx
NFoXDTM2MDkyMjA3MjgxNFowKzESMBAGA1UEAwwJMTI3LjAuMC4xMRUwEwYDVQQK
DAxBbGNoZW15IFRlc3QwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAQJuzLzWy1z
r77T1Ur/yYWLVtlLqS/QNDiXHxesdn14N3txQGcp/81uchhLSoxeyKkTmjPsRM6I
tq/95meZ2QFPoxMwETAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0cAMEQC
IGpvvw70ZXXSX/hf/sRhE3gZ3Eg5fTaqW6zmd5ZzV2ceAiBsvcIH4VA43T5gn4Js
4HJB3TnLUFRp1Y3IzAqIifcyLg==
-----END CERTIFICATE-----
`;

/** Private key for {@link LOCALHOST_CERT}. Test-only; never trusted. */
export const LOCALHOST_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIGn+IUihpLocpD6DVmyghm6DI4mCjoxJbnEfTzzxry/PoAoGCCqGSM49
AwEHoUQDQgAECbsy81stc6++09VK/8mFi1bZS6kv0DQ4lx8XrHZ9eDd7cUBnKf/N
bnIYS0qMXsipE5oz7ETOiLav/eZnmdkBTw==
-----END EC PRIVATE KEY-----
`;
