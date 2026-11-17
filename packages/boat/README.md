# @alchemy.run/boat

[Boat](https://boat.dev) for [Alchemy](https://alchemy.run). Boat runs sandboxes: Linux machines with Docker, passwordless `sudo` and a desktop that start in under a second, stop on a timer with their disk saved, and resume, fork or snapshot from where they stopped. Declare sandboxes, snapshots, environments and webhooks in your Stack, and create sandboxes from any Worker or Lambda.

```sh
npm install alchemy @alchemy.run/boat effect
```

A sandbox that runs a program. Alchemy bundles it, uploads it and starts it with Node.js, and serves its port at a URL:

```typescript
// src/Api.ts
import * as Boat from "@alchemy.run/boat";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class Api extends Boat.Sandbox<Api>()(
  "Api",
  { main: import.meta.url, type: "small", noEnv: true, public: true },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({ ok: true });
      }),
    };
  }),
) {}
```

```typescript
// alchemy.run.ts
import * as Boat from "@alchemy.run/boat";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";

export default Alchemy.Stack(
  "MyApp",
  { providers: Boat.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const api = yield* Api;
    return { url: api.url.as<string>() };
  }),
);
```

A deploy that changes the code restarts the program in the same sandbox, so its disk and URL stay the same.

For a sandbox per request or per task, build a snapshot once at deploy and bind `Boat.CreateSandbox(Golden)` in a Worker or Lambda. Each sandbox starts with the snapshot's disk:

```typescript
// src/Golden.ts
import * as Boat from "@alchemy.run/boat";

export const Golden = Boat.Snapshot("Golden", {
  run: ["git clone --depth 1 https://github.com/sindresorhus/is ~/repo"],
});
```

```typescript
const sandboxes = yield* Boat.CreateSandbox(Golden);

// per request
const sandbox = yield* Effect.acquireRelease(
  sandboxes.create({ noEnv: true, autoStop: "5 minutes" }),
  (sandbox) => Effect.ignore(sandbox.delete()),
);
const result = yield* sandbox.exec("npm test", { cwd: "/home/user/repo" });
```

Docs: [alchemy.run/boat](https://alchemy.run/boat) · [Setup](https://alchemy.run/boat/setup) · [Tutorial](https://alchemy.run/boat/tutorial/part-1). Reference: [alchemy.run/providers](https://alchemy.run/providers).
