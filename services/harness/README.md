# harness

Alchemy's hosted coding-agent harness: Claude Code agents working on [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy), one per issue, each in its own Cloudflare Container, behind one HTTP API and a web UI. Deployed with Alchemy.

```
HTTP ──▶ Worker ──▶ Agent (Durable Object, one per issue) ──▶ Sandbox (Container)
                     AgentRpcs                                 Claude Code
```

- `src/Sandbox.ts`, `src/Sandbox.impl.ts` — the machine Claude Code runs in, and its program. `Anthropic.ClaudeCodeServer` installs the official Agent SDK (and the unmodified `claude` binary) into the image and serves sessions on the machine's port. The image holds only the toolchain. Hosted by `src/Sandbox.cf.ts` (a Cloudflare Container, the default) or `src/Sandbox.aws.ts` (an AWS Lambda MicroVM).
- `src/Gateway.ts`, `src/Gateway.impl.ts` — the egress gateway (`Gateway`): which hosts a machine may reach, and the model API key and your GitHub login it adds to their requests. Hosted by `src/Gateway.aws.ts` (a Lambda Web Function in four Regions, the default) or `src/Gateway.cf.ts` (a Cloudflare Worker).
- `src/AgentRpcs.ts` — this app's API (`AgentRpcs`), shared by the Durable Object and the web UI.
- `src/Agent.ts` — one Durable Object per issue, serving `AgentRpcs`. It starts the session's container with egress from `Gateway` (`Anthropic.Egress`, `GitHub.Egress`), so the container holds no credentials: the gateway checks each request and adds them. It clones the repository into a container that has none; `Cloudflare.Containers.Harness` checkpoints the session's work into the Durable Object after every turn and keeps its history there, so a session resumes on any container.
- `src/Worker.ts` — the HTTP API.

## Develop and deploy

Each session works in a shallow clone of [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy); the agent installs dependencies when it needs them. `git` and `gh` act as your GitHub login (the stack's GitHub auth profile), limited to pushing `agent/**` branches:

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # read by the gateway, never the container
bun alchemy dev      # Worker + DO in workerd, the container in local Docker
bun alchemy deploy   # Cloudflare Containers; the gateway on AWS Lambda
```

## Use it

Start a session and run a turn:

```sh
curl -X POST $URL/agents/fix-42 -d '{"prompt":"Add a CONTRIBUTING.md"}'
```

Follow its events (server-sent, resumable with `?after=<cursor>`):

```sh
curl -N $URL/agents/fix-42/events
```

Steer or stop it mid-turn:

```sh
curl -X POST $URL/agents/fix-42/steer -d '{"prompt":"keep it under 20 lines"}'
curl -X POST $URL/agents/fix-42/interrupt
```

## Test

End-to-end tests drive the API and the web UI (Playwright). They start
`alchemy dev` (or reuse a running one), so run them with the same
environment:

```sh
doppler run -- pnpm test:e2e
```

Point them at a deployment with `WEB_URL` and `API_URL`.
