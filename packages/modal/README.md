# @alchemy.run/modal

[Modal](https://modal.com) for [Alchemy](https://alchemy.run). Deploy Effect programs as Modal Functions and Servers, with GPUs, volumes and secrets, and create sandboxes, dicts and queues at run time.

```sh
npm install alchemy @alchemy.run/modal effect
```

An App and a Volume of model weights:

```typescript
// src/Storage.ts
import * as Modal from "@alchemy.run/modal";

export const Inference = Modal.App("Inference", {});

export const Models = Modal.Volume("Models", {});
```

A GPU Function that reads the weights from the volume. Each method it returns is an RPC method other runtimes call:

```typescript
// src/Embed.ts
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Inference, Models } from "./Storage.ts";

export default class Embed extends Modal.Function<Embed>()(
  "Embed",
  {
    main: import.meta.url,
    app: Inference,
    gpu: "L4",
    mounts: [{ volume: Models, path: "/models", readOnly: true }],
  },
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return {
      embed: Effect.fn(function* (text: string) {
        const models = yield* fs.readDirectory("/models").pipe(Effect.orDie);
        return { models, tokens: text.split(/\s+/).length };
      }),
    };
  }),
) {}
```

A public Server that calls it:

```typescript
// src/Api.ts
import * as Modal from "@alchemy.run/modal";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import Embed from "./Embed.ts";
import { Inference } from "./Storage.ts";

export default class Api extends Modal.Server<Api>()(
  "Api",
  { main: import.meta.url, app: Inference, unauthenticated: true },
  Effect.gen(function* () {
    const embed = yield* Modal.InvokeFunction(Embed);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const text = new URL(request.url, "http://api").searchParams.get("text") ?? "";
        return yield* HttpServerResponse.json(yield* embed.embed(text));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Modal.InvokeFunctionHttp)),
) {}
```

And the Stack:

```typescript
// alchemy.run.ts
import * as Modal from "@alchemy.run/modal";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "Inference",
  {
    providers: Layer.mergeAll(Modal.providers(), Modal.DeployerHostIdentity),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url };
  }),
);
```

`Modal.DeployerHostIdentity` lets the Server call `Embed` with your Modal token, which works on every plan. On a Team or Enterprise workspace, drop it to give each runtime its own scoped service user.

Docs: [alchemy.run/modal](https://alchemy.run/modal) · [Setup](https://alchemy.run/modal/setup) · [Tutorial](https://alchemy.run/modal/tutorial/part-1). Reference: [alchemy.run/providers](https://alchemy.run/providers).
