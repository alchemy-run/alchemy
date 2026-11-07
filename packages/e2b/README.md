# @alchemy.run/e2b

[E2B](https://e2b.dev) for [Alchemy](https://alchemy.run). Declare the templates and warm snapshots your sandboxes boot from, then create, run, pause, fork, and kill sandboxes from any Worker or Function.

```sh
npm install alchemy @alchemy.run/e2b effect
```

A template, and a Worker that runs code in a fresh sandbox per request:

```typescript
// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Agent = E2B.Template("Agent", { image: "node:22-bookworm" });

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url },
  Effect.gen(function* () {
    const sandboxes = yield* E2B.CreateSandbox(Agent);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const sandbox = yield* Effect.acquireRelease(
          sandboxes.create({ timeout: 120, network: { allowOut: [] } }),
          (sandbox) => Effect.ignore(sandbox.kill()),
        );
        const code = yield* request.text;
        yield* sandbox.files.write("main.mjs", code);
        const result = yield* sandbox.commands.run("node main.mjs");
        return yield* HttpServerResponse.json(result);
      }).pipe(Effect.scoped, Effect.orDie),
    };
  }).pipe(Effect.provide(E2B.CreateSandboxHttp)),
) {}
```

Docs: [alchemy.run/e2b](https://alchemy.run/e2b). Reference: [alchemy.run/providers/e2b](https://alchemy.run/providers/e2b).
