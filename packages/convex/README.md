# @alchemy.run/convex

Convex for [Alchemy](https://alchemy.run). Declare Convex projects, deployments and keys in the same TypeScript program as the rest of your infrastructure, push your functions on every deploy, and call them from any host.

```sh
npm install alchemy @alchemy.run/convex convex effect
```

A project, a preview deployment per stage, and your functions:

```typescript
// alchemy.run.ts
import * as Convex from "@alchemy.run/convex";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MyApp",
  { providers: Convex.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const project = yield* Convex.Project("App");
    const deployment = yield* Convex.Deployment("Backend", { project, type: "preview" });
    yield* Convex.Functions("Functions", { deployment, rootDir: "." });
    return { url: deployment.url };
  }),
);
```

See the [Convex docs](https://alchemy.run/convex) to get started.
