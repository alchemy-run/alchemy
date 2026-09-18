# Neon managed authentication

A browser signup/signin demo backed by managed Neon Auth. It deploys an isolated
project and branch, a native Function serving the page and auth proxy, and an
Effect Function verifying the same JWTs through `Neon.ConnectAuth`.

## Deploy

Use Node.js 24+, the installed workspace dependencies, and an Alchemy `testing`
profile with Neon backend access in `aws-us-east-2`. Deployment creates real cloud
resources. An exported `NEON_API_KEY` overrides profile credentials; unset it if
you intend to use only the profile. Never put an account API key in the browser.

From this directory:

```sh
timeout 240 pnpm --config.verify-deps-before-run=false exec alchemy deploy --stage auth-demo --profile testing --yes
```

Keep the same directory, local `.alchemy` state, profile, and stage for cleanup.
No application secrets need to be configured: Neon injects the native Auth URLs,
and the Effect binding supplies its public connection configuration. Do not
override Neon's reserved environment variables.

## Try it

Open the printed `url` on desktop or mobile:

1. Before signing in, **Call protected API** and **Try invalid token** return 401.
2. Enter a disposable email and a password of at least eight characters. Click
   **Create account**, then **Call protected API**; the response should be 200.
3. Reload. The page restores the cookie-backed session and obtains a fresh JWT.
4. **Sign out**, then reload. The protected API returns 401 until you sign in again.
5. Sign in with the same credentials. A wrong password returns 401.

`GET /api/profile` accepts `Authorization: Bearer <JWT>`. The printed
`effectApiUrl` exposes the equivalent Effect API; use a server-side HTTP client
with the same bearer token, not a browser cross-origin shortcut. Tokens are
sensitive: do not log, paste into documentation, or persist them in localStorage.
Unknown page routes return 404, including on refresh.

## Security and session behavior

- Email verification is **disabled for this disposable demo**. Enable it in
  `src/resources.ts` before using real accounts.
- The trusted domain is the exact site **origin**, without a trailing slash.
  Cross-origin auth requests are rejected. Localhost is not trusted by this stack.
- JWTs are verified with `jose` against the managed JWKS, issuer, and expiry.
  Live verification observed a 900-second token lifetime. Signout revokes the
  session and prevents new tokens; an already-issued JWT remains valid until
  expiry. Immediate API revocation requires an additional session check.
- The page holds its JWT only in memory. Reload restoration uses the managed
  session cookie. Users and sessions are application data, not IaC resources.

## Destroy

Sign out, then remove this example's resources through the normal stack lifecycle:

```sh
timeout 240 pnpm --config.verify-deps-before-run=false exec alchemy destroy --stage auth-demo --profile testing --yes
```

Do not erase state or directly delete resources to recover a failed deployment.
Report provider failures instead. During the September 17, 2026 browser check,
desktop/mobile auth flows and native/Effect JWT verification passed; a recovery
read in `AuthTrustedDomain` logged a provider error before deployment recovered.
