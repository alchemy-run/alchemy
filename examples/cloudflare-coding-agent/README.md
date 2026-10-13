# cloudflare-coding-agent

Many Claude Code agents behind one HTTP API, each in its own Cloudflare Container.

```
HTTP ──▶ Worker ──▶ Agent (Durable Object, one per issue) ──▶ Sandbox (Container)
                     AgentRpcs                                 Claude Code
```

- `src/Sandbox.runtime.ts` — the container program. `Anthropic.ClaudeCodeServer` installs the official Agent SDK (and the unmodified `claude` binary) into the image and serves sessions on the container port. The image holds only the toolchain.
- `src/rpcs.ts` — this app's API (`AgentRpcs`), shared by the Durable Object and the web UI.
- `src/Agent.ts` — one Durable Object per issue, serving `AgentRpcs`. It starts the session's container with egress (`Anthropic.Egress`, `GitHub.Egress`), so the container holds no credentials: the Durable Object adds them to its requests and decides what it may reach. It clones the repository into a container that has none; `Cloudflare.Containers.Harness` checkpoints the session's work into the Durable Object after every turn and keeps its history there, so a session resumes on any container.
- `src/worker.ts` — the HTTP API.

## Run it

Each session works in a shallow clone of [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy); the agent installs dependencies when it needs them. `git` and `gh` act as your GitHub login (the stack's GitHub auth profile), limited to pushing `agent/**` branches:

```sh
export ANTHROPIC_API_KEY=sk-ant-...   # read by the Worker, never the container
bun alchemy dev      # Worker + DO in workerd, the container in local Docker
bun alchemy deploy   # Cloudflare Containers
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

Swap the harness by swapping the server: `OpenAI.CodexServer`, `OpenCode.Server`, or any ACP agent with `AI.AcpServer`.

## Test it

End-to-end tests drive the API and the web UI (Playwright). They start
`alchemy dev` (or reuse a running one), so run them with the same
environment:

```sh
doppler run -- pnpm test:e2e
```

Point them at a deployment with `WEB_URL` and `API_URL`.
