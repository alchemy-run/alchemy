# @alchemy.run/openrouter

[OpenRouter](https://openrouter.ai) for [Alchemy](https://alchemy.run). Mint budgeted API keys and guardrails, and call any OpenRouter model from a Worker or Lambda, in the same TypeScript program as the rest of your infrastructure.

```sh
npm install alchemy @alchemy.run/openrouter effect
```

An API key for one agent, capped at $25 a month:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as OpenRouter from "@alchemy.run/openrouter";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "Research",
  {
    providers: OpenRouter.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const key = yield* OpenRouter.ApiKey("ResearchAgent", {
      limit: 25,
      limitReset: "monthly",
    });

    return { keyHash: key.hash };
  }),
);
```

Connect your account once with `alchemy profile edit --add OpenRouter`.

## Learn more

- [OpenRouter on alchemy.run](https://alchemy.run/providers/openrouter)
