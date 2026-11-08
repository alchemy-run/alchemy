# @alchemy.run/e2b

[E2B](https://e2b.dev) for [Alchemy](https://alchemy.run). Declare the templates, snapshots and sandboxes your app uses, run Effect programs in sandboxes, and create, run, pause, fork and kill sandboxes from any Worker or Lambda.

```sh
npm install alchemy @alchemy.run/e2b effect
```

A template with a program in it. E2B snapshots the template once the program answers, so every sandbox boots with it already serving:

```typescript
// src/Program.ts
import * as E2B from "@alchemy.run/e2b";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export default class Program extends E2B.Template<Program>()(
  "Program",
  { main: import.meta.url, port: 3000 },
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("hello from a sandbox")),
    };
  }),
) {}
```

And a Stack with one long-lived sandbox serving it. E2B pauses the sandbox when it's idle, and a request to its URL resumes it:

```typescript
// alchemy.run.ts
import * as E2B from "@alchemy.run/e2b";
import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import Program from "./src/Program.ts";

export default Alchemy.Stack(
  "Sandboxes",
  { providers: E2B.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const sandbox = yield* E2B.Sandbox("Api", { template: Program });
    return { url: Output.interpolate`https://3000-${sandbox.sandboxId}.${sandbox.domain}` };
  }),
);
```

For a sandbox per request or per task, bind `E2B.CreateSandbox(Program)` in a Worker or Lambda:

```typescript
const sandboxes = yield* E2B.CreateSandbox(Program);

// per request
const sandbox = yield* Effect.acquireRelease(
  sandboxes.create({ timeout: 120, network: { allowOut: [] } }),
  (sandbox) => Effect.ignore(sandbox.kill()),
);
const result = yield* sandbox.exec("bun --version");
```

Docs: [alchemy.run/e2b](https://alchemy.run/e2b). Reference: [alchemy.run/providers](https://alchemy.run/providers).
