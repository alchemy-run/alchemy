# harness

Alchemy's hosted coding-agent harness: Claude Code agents working on [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy), one per issue, each in its own Cloudflare Container, behind one HTTP API and a web UI. Deployed with Alchemy.

```
HTTP ──▶ Worker ──▶ Agent (Durable Object, one per issue) ──▶ Sandbox (Container)
                     AgentRpcs                                 Claude Code
```

- `src/Sandbox.ts`, `src/Sandbox.impl.ts` — the machine Claude Code runs in, and its program. `Anthropic.ClaudeCodeServer` installs the official Agent SDK (and the unmodified `claude` binary) into the image and serves sessions on the machine's port. The image holds only the toolchain. Hosted by `src/Sandbox.cf.ts` (a Cloudflare Container, the default) or `src/Sandbox.aws.ts` (an AWS Lambda MicroVM).
- `src/Gateway.ts`, `src/Gateway.impl.ts` — the egress gateway (`Gateway`): which hosts a machine may reach, and the model API key and your GitHub login it adds to their requests. Hosted by `src/Gateway.aws.ts` (a Lambda Web Function in four Regions, the default) or `src/Gateway.cf.ts` (a Cloudflare Worker).
- `src/AgentRpcs.ts`, `src/HarnessRpcs.ts` — the API: a session's `AgentRpcs` (served by its Durable Object), and `HarnessRpcs` (served by the Worker: every session's `AgentRpcs` plus `list`), shared by the Worker, the web UI and the e2e tests.
- `src/Agent.ts` — one Durable Object per issue, serving `AgentRpcs`. It starts the session's container with egress from `Gateway` (`Anthropic.Egress`, `GitHub.Egress`), so the container holds no credentials: the gateway checks each request and adds them. It clones the repository into a container that has none; `Cloudflare.Containers.Harness` checkpoints the session's work into the Durable Object after every turn and keeps its history there, so a session resumes on any container.
- `src/Worker.ts` — serves `HarnessRpcs` over HTTP, forwarding each call to its session's Durable Object.

## Develop and deploy

Each session works in a shallow clone of [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy); the agent installs dependencies when it needs them. `git` and `gh` act as your GitHub login (the stack's GitHub auth profile), limited to pushing `agent/**` branches:

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # read by the gateway, never the container
bun alchemy dev      # Worker + DO in workerd, the container in local Docker
bun alchemy deploy   # Cloudflare Containers; the gateway on AWS Lambda
```

## Use it

The API is Effect RPC over HTTP: `HarnessRpcs` (`src/HarnessRpcs.ts`), every session's `AgentRpcs` plus `list`. Each call names its session and goes to that session's Durable Object.

```ts
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Stream from "effect/Stream";
import { HarnessRpcs } from "./src/HarnessRpcs.ts";

const program = Effect.gen(function* () {
  const api = yield* RpcClient.make(HarnessRpcs);
  yield* api.start({ sessionId: "fix-42" });
  const { turnId } = yield* api.prompt({ sessionId: "fix-42", prompt: "Add a CONTRIBUTING.md" });
  // Steer or stop it mid-turn: api.steer({ sessionId, prompt }), api.interrupt({ sessionId })
  const result = yield* api.result({ sessionId: "fix-42", turnId });
  // Its events, resumable from a cursor
  yield* api.events({ sessionId: "fix-42", after: 0 }).pipe(Stream.take(10), Stream.runDrain);
  return result;
}).pipe(
  Effect.scoped,
  Effect.provide(
    RpcClient.layerProtocolHttp({ url: process.env.API_URL! }).pipe(
      Layer.provide(Layer.mergeAll(RpcSerialization.layerNdjson, FetchHttpClient.layer)),
    ),
  ),
);
```

## Test

End-to-end tests drive the API and the web UI (Playwright). They start
`alchemy dev` (or reuse a running one), so run them with the same
environment:

```sh
doppler run -- pnpm test:e2e
```

Point them at a deployment with `WEB_URL` and `API_URL`.
