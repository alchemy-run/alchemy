# vinext on Archil

Deploy a vinext App Router application with `Archil.Website.Vinext`.
Production runs vinext's Node server as an Archil service in an Archil sandbox.

```typescript
const site = yield* Archil.Website.Vinext("Web", {
  env: { GREETING: "Hello from vinext on Archil!" },
});
```

The example includes client hydration, Home/ISR navigation, an environment-aware
`/api/hello?name=Alchemy` endpoint, ISR, and public assets.
The default cache is process-local. Configure a shared Redis store through `env.REDIS_URL` for persistence across restarts and replicas.
Alchemy injects the cache adapter automatically. Keep ordinary `vinext()`
configuration in Vite; configure deployment on `Website.Vinext`.

## Run locally

```sh
bun install
bun alchemy dev
```

The Website runs native `vinext dev` with hot reload and creates no cloud
resources. Apply `Alchemy.remote()` to deploy live during development.

## Deploy

Configure [Archil credentials](https://alchemy.run/archil/setup), then run:

```sh
bun alchemy deploy
```

Shared props are `rootDir`, `env`, `memo`, `assets`, `dev`, and `domain`.
Archil additionally requires `zone` for custom domains. The integration
package must be installed in the application; it is loaded at build time.

## Test and clean up

```sh
bun test test/dev.test.ts
ALCHEMY_PROFILE=testing bun test test/integ.test.ts
bun alchemy destroy
```

The live suite destroys its previous stack before deploying and cleans up
afterward. See the [vinext guide](https://alchemy.run/archil/frontend/vinext).
