# Domain + better-auth on Cloudflare

Signs users in to a Domain Api with GitHub or Google through [better-auth](https://better-auth.com). Companion to the [Sign in with better-auth](https://alchemy.run/domain/better-auth) page.

## Run locally

```sh
pnpm install
cd examples/cloudflare-domain-better-auth
cp .env.example .env   # add your GitHub and Google OAuth credentials
bun run dev
```

Register `http://localhost:1337/api/auth/callback/github` and `http://localhost:1337/api/auth/callback/google` as the callback URLs of your OAuth apps.

## Test

```sh
pnpm test
```

The tests sign users in through a local OpenID Connect provider, then call the Api over HTTP with the session cookie.
