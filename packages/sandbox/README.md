# @alchemy.run/sandbox

Sandboxes and volumes for [Alchemy](https://alchemy.run). A sandbox is a machine a Durable Object starts, runs commands in, and stops. A volume is a disk in object storage, forked per session from a base image and attached to a sandbox only for the length of one command.

```sh
npm install alchemy @alchemy.run/sandbox effect
```

Declare a machine and a disk, then host them on Cloudflare:

```typescript
// src/Machine.ts
import * as Sandbox from "@alchemy.run/sandbox";

export class Machine extends Sandbox.Sandbox<Machine, { size: "small" }>()("Machine") {}
export class Workspace extends Sandbox.Volume<Workspace>()("Workspace") {}
```

```typescript
// src/Machine.cloudflare.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { Machine, Workspace } from "./Machine.ts";

export const MachineLive = Layer.mergeAll(
  Cloudflare.Containers.Sandbox(
    Machine,
    { main: import.meta.url, runtime: "node", image: "node:24-bookworm", sizes: { small: "standard-1" } },
    Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("ok")) }),
  ),
  Cloudflare.R2.Volume(Workspace, { size: "8 GB" }),
);
```

Use them from a Durable Object:

```typescript
// src/Agent.ts
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Machine, Workspace } from "./Machine.ts";

export class Agent extends Cloudflare.DurableObject<Agent>()(
  "Agent",
  Effect.gen(function* () {
    const machine = yield* Machine;
    const disk = yield* Workspace.on(Machine);
    return Effect.gen(function* () {
      return {
        run: Effect.fn(function* (session: string, command: string) {
          if (!(yield* disk.head(session))) yield* disk.fork(session);
          yield* machine.start({ size: "small" });
          return yield* disk.exec(session, command);
        }),
      };
    });
  }),
) {}
```
