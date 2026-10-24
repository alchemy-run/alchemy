# @alchemy.run/anthropic

[Anthropic](https://www.anthropic.com) for [Alchemy](https://alchemy.run). Declare workspaces and spend limits, call Claude from a Worker or Lambda, and run Claude Code in a sandbox, in the same TypeScript program as the rest of your infrastructure.

```sh
npm install alchemy @alchemy.run/anthropic effect
```

A workspace for your agents, with a monthly cap for one member:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as Anthropic from "@alchemy.run/anthropic";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Agents",
  {
    providers: Anthropic.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const workspace = yield* Anthropic.Workspace("Agents", {});

    yield* Anthropic.SpendLimit("AliceMonthly", {
      userId: "user_01WCz1FkmYMm4gnmykNKUu3Q",
      amount: 50_000,
    });

    return { workspaceId: workspace.workspaceId };
  }),
);
```

Connect your account once with `alchemy profile edit --add Anthropic`.

## Learn more

- [Anthropic on alchemy.run](https://alchemy.run/providers/anthropic)
