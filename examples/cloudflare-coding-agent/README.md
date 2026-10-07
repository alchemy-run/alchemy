# cloudflare-coding-agent

Many Claude Code agents behind one HTTP API, each in its own Cloudflare Container.

```
HTTP ──▶ Worker ──▶ Agent (Durable Object, one per session) ──▶ Sandbox (Container)
                     AI.SessionRpcs                              Claude Code
```

- `src/Sandbox.runtime.ts` — the container program. It mounts the repository (`GitHub.MountRepository`), and `Anthropic.ClaudeCodeServer` installs the official Agent SDK (and the unmodified `claude` binary) into the image and serves sessions on the container port.
- `src/Agent.ts` — one Durable Object per session, serving the standard `AI.SessionRpcs` contract.
- `src/worker.ts` — the HTTP API.

## Run it

Each session works in a checkout of [alchemy-run/alchemy](https://github.com/alchemy-run/alchemy), with dependencies installed and TypeScript built. Give it a GitHub token for `git push` and the `gh` CLI:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
export GITHUB_TOKEN=$(gh auth token)
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
GITHUB_TOKEN=$(gh auth token) doppler run -- pnpm test:e2e
```

Point them at a deployment with `WEB_URL` and `API_URL`.
