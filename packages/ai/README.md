# @alchemy.run/ai

Agent harnesses for [Alchemy](https://alchemy.run). Run Claude Code, Codex or OpenCode inside a sandbox, drive it as a session that streams typed events, and keep the session's history in a Durable Object.

```sh
npm install alchemy @alchemy.run/ai effect
```

Declare the sandbox an agent works in, with the egresses it may use:

```typescript
// src/Sandbox.ts
import * as AI from "@alchemy.run/ai";
import * as Anthropic from "@alchemy.run/anthropic";
import * as GitHub from "@alchemy.run/github";

export class Sandbox extends AI.Sandbox<
  Sandbox,
  { size: "large"; egress: Anthropic.Egress | GitHub.Egress }
>()("Sandbox", { egress: [Anthropic.Egress, GitHub.Egress] }) {}
```

Host it on a Cloudflare Container (`Cloudflare.Containers.Sandbox`) or on AWS Lambda MicroVMs (`AWS.Lambda.MicrovmSandbox`), and `yield* Sandbox` from the Durable Object that owns the session.

## Learn more

- [AI on alchemy.run](https://alchemy.run/providers/ai)
