# @alchemy.run/portless

[Portless](https://github.com/vercel-labs/portless) for [Alchemy](https://alchemy.run). Give dev servers and local ports stable HTTPS names such as `https://dev-alice.api.myapp.localhost`, through one shared proxy: no port numbers, no hosts-file edits, no certificate warnings.

```sh
npm install alchemy @alchemy.run/portless effect
```

Portless needs Node.js 24 or newer. Declare the proxy, then the services behind it:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Portless from "@alchemy.run/portless";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  {
    providers: Portless.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const proxy = yield* Portless.Proxy("Proxy", { domain: "myapp" });

    // Known before Web starts, so Api's CORS list can hold it.
    const webOrigin = yield* Portless.Origin("Web", { proxy, port: 5173 });

    const api = yield* Portless.Dev("Api", {
      proxy,
      command: "node --watch server.ts",
      env: { CORS_ORIGIN: webOrigin },
    });
    const web = yield* Portless.Dev("Web", {
      proxy,
      port: 5173,
      command: "vite --port $PORT --strictPort",
      env: { API_URL: api.origin },
    });

    // A name for a port something else owns.
    const floci = yield* Portless.Alias("Floci", {
      proxy,
      url: "http://localhost:4566",
    });

    return { api: api.origin, web: web.origin, floci: floci.origin };
  }),
);
```

`alchemy dev` starts the proxy when it isn't running, reuses it when it is, and never stops it. The first run asks the operating system once to trust the proxy's certificate authority; later runs, stages and worktrees prompt for nothing. `alchemy deploy` ignores these resources, and `PORTLESS=0` skips the proxy: `Dev` then serves `http://localhost:<port>`.

A Worker or any other host calls a `Dev` with `Portless.Fetch`, which resolves relative URLs against the service's origin and is dev-only:

```ts
const api = yield* Portless.Fetch(Api); // Api is a Portless.Dev
const response = yield* api(HttpClientRequest.get("/health"));
```

Provide `Portless.FetchHttp` on the Worker's Effect.

## Learn more

- [Portless on alchemy.run](https://alchemy.run/portless)
- [API reference](https://alchemy.run/providers)
