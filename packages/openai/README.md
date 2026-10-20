# @alchemy.run/openai

[OpenAI](https://openai.com) for [Alchemy](https://alchemy.run). Declare projects, service accounts and rate limits, call models from a Worker or Lambda, and run Codex in a sandbox, in the same TypeScript program as the rest of your infrastructure.

```sh
npm install alchemy @alchemy.run/openai effect
```

A project for your app, with a service account it calls the API as:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as OpenAI from "@alchemy.run/openai";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "App",
  {
    providers: OpenAI.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const project = yield* OpenAI.Project("App");
    const account = yield* OpenAI.ServiceAccount("Backend", {
      projectId: project.projectId,
    });

    return { projectId: project.projectId, serviceAccountId: account.serviceAccountId };
  }),
);
```

Connect your account once with `alchemy profile edit --add OpenAI`.

## Learn more

- [OpenAI on alchemy.run](https://alchemy.run/providers/openai)
