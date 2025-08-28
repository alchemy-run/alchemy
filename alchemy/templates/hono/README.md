### Minimal Hono + Alchemy Template

### Run
- bun install
- bun run dev

### Deploy
- bun run deploy
- bun run destroy

### Alchemy
- Resource: defined in `alchemy.run.ts` (Worker + KV)
- Binding: `KV` bound to Worker as `c.env.KV`
- Types: inferred in `types/env.d.ts`

### References
- Alchemy Getting Started: https://alchemy.run/getting-started
- Alchemy CLI: https://alchemy.run/concepts/cli
- Bindings: https://alchemy.run/concepts/bindings