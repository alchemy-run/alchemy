# @alchemy.run/daytona

[Daytona](https://daytona.io) for [Alchemy](https://alchemy.run). Declare the snapshots, volumes and secrets your sandboxes use, run Effect programs in long-lived sandboxes, and create, drive and delete sandboxes from any Worker or Lambda.

```sh
npm install alchemy @alchemy.run/daytona effect
```

A snapshot to boot from, with its size, and a volume whose files outlive every sandbox:

```typescript
// src/Storage.ts
import * as Daytona from "@alchemy.run/daytona";

export const Base = Daytona.Snapshot("Base", {
  image: "node:22-bookworm-slim",
  cpu: 1,
  memory: 1,
  disk: 3,
});

export const Data = Daytona.Volume("Data", {});
```

A sandbox that runs a program, mounts the volume, and serves on its preview URL:

```typescript
// src/Agent.ts
import * as Daytona from "@alchemy.run/daytona";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Base, Data } from "./Storage.ts";

export default class Agent extends Daytona.Sandbox<Agent>()(
  "Agent",
  { snapshot: Base, main: import.meta.url, public: true },
  Effect.gen(function* () {
    const data = yield* Daytona.MountVolume(Data, { path: "/data" });
    const fs = yield* FileSystem.FileSystem;
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json(yield* fs.readDirectory(data.path));
      }).pipe(Effect.orDie),
    };
  }).pipe(Effect.provide(Daytona.MountVolumeLive)),
) {}
```

And the Stack:

```typescript
// alchemy.run.ts
import * as Daytona from "@alchemy.run/daytona";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Agent from "./src/Agent.ts";

export default Alchemy.Stack(
  "Agents",
  { providers: Daytona.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const agent = yield* Agent;
    return { url: agent.url };
  }),
);
```

For a sandbox per request or per user, bind `Daytona.CreateSandbox(Base)` in a Worker or Lambda. The binding gives that runtime its own API key, which can only create and delete sandboxes:

```typescript
const sandboxes = yield* Daytona.CreateSandbox(Base);

// per request
const sandbox = yield* Effect.acquireRelease(sandboxes.create(), (s) =>
  sandboxes.delete(s.sandboxId).pipe(Effect.ignore),
);
const result = yield* sandbox.exec("node --version");
```

Docs: [alchemy.run/daytona](https://alchemy.run/daytona) · [Setup](https://alchemy.run/daytona/setup) · [Tutorial](https://alchemy.run/daytona/tutorial/part-1). Reference: [alchemy.run/providers](https://alchemy.run/providers).
