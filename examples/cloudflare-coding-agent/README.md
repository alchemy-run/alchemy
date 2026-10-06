# cloudflare-coding-agent

Many Claude Code agents behind one HTTP API, each in its own Cloudflare Container.

```
HTTP ──▶ Worker ──▶ Agent (Durable Object, one per session) ──▶ Sandbox (Container)
                     AI.SessionRpcs                              Claude Code
```

- `src/Workspace.ts` — the repository every agent works in (`AI.Environment`, a binding that installs its checkout into whatever container yields it).
- `src/Sandbox.runtime.ts` — the container program. It yields the workspace, and `Anthropic.ClaudeCodeServer` installs the official Agent SDK (and the unmodified `claude` binary) into the image and serves sessions on the container port.
- `src/Agent.ts` — one Durable Object per session, serving the standard `AI.SessionRpcs` contract.
- `src/worker.ts` — the HTTP API.

## Run it

```sh
export ANTHROPIC_API_KEY=sk-ant-...
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
