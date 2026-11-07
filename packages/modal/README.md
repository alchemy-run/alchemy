# @alchemy.run/modal

Modal sandboxes, images, volumes, dicts, queues and secrets for [Alchemy](https://alchemy.run).

```sh
npm install @alchemy.run/modal
```

```typescript
// src/Api.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Coder = Modal.App("Coder", {});
export const Node = Modal.Image("Node", { app: Coder, image: "node:22-bookworm" });

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const sandboxes = yield* Modal.CreateSandbox(Node);
    return {
      fetch: Effect.gen(function* () {
        const sandbox = yield* sandboxes.create({ timeout: "5 minutes" });
        const result = yield* sandbox
          .exec(["node", "--version"])
          .pipe(Effect.ensuring(Effect.ignore(sandbox.terminate())));
        return HttpServerResponse.text(result.stdout);
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Modal.CreateSandboxHttp)),
) {}
```

Docs: [alchemy.run/modal](https://alchemy.run/modal) · [Setup](https://alchemy.run/modal/setup) · [Tutorial](https://alchemy.run/modal/tutorial/part-1)
