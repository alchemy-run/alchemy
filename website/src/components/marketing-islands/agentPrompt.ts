export const AGENT_PROMPT = `Help me build an Alchemy app on Cloudflare. Start by reading https://v2.alchemy.run/getting-started and follow it exactly: scaffold a fresh project, install the dependencies, create the \`alchemy.run.ts\` Stack with a single Cloudflare R2 Bucket (no Worker yet), and run \`alchemy deploy\` so I sign in to Cloudflare and provision the Bucket. Confirm the Bucket is live before moving on.

Then STOP and ASK ME what I want to build. From there, consult only the docs you need for what I asked for — don't march me through every tutorial. A Worker only gets added later if what I want to build needs one (the tutorial covers that in part-2).

Reference material (read on demand, skip the rest):

Tutorial — foundations, work through whichever parts I haven't touched:
  https://v2.alchemy.run/tutorial/part-1  First Stack (state store + first resource)
  https://v2.alchemy.run/tutorial/part-2  Add a Worker
  https://v2.alchemy.run/tutorial/part-3  Testing
  https://v2.alchemy.run/tutorial/part-4  Local Dev (\`alchemy dev\`)
  https://v2.alchemy.run/tutorial/part-5  CI/CD (per-PR previews from GitHub Actions)

Cloudflare deep-dives — mix and match:
  https://v2.alchemy.run/tutorial/cloudflare/durable-objects         per-key state, RPC, Effect Streams
  https://v2.alchemy.run/tutorial/cloudflare/hibernatable-websockets WebSockets that survive hibernation
  https://v2.alchemy.run/tutorial/cloudflare/vite-spa                Vite SPA frontend (TanStack / SolidStart / Vue / etc.)
  https://v2.alchemy.run/tutorial/cloudflare/containers              long-lived process per Durable Object
  https://v2.alchemy.run/tutorial/cloudflare/workflows               durable multi-step orchestration

Guides — cross-cutting how-tos:
  https://v2.alchemy.run/guides/effect-http-api     schema-validated HTTP API
  https://v2.alchemy.run/guides/effect-rpc          typed RPC
  https://v2.alchemy.run/guides/frontends           framework-specific Vite setup
  https://v2.alchemy.run/guides/testing             integration testing patterns
  https://v2.alchemy.run/guides/ci                  alternative CI setups
  https://v2.alchemy.run/guides/circular-bindings   two services that reference each other
  https://v2.alchemy.run/guides/migrating-from-v1   migrating from v1 (async/await)
  https://v2.alchemy.run/guides/cli                 CLI reference

Important:
- Confirm with me before each deploy. Don't batch.
- Do NOT instruct me to export CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. Alchemy stores credentials in profiles — \`alchemy login\` (or the first \`alchemy deploy\`) prompts interactively for OAuth or an API token and saves it to ~/.alchemy/profiles.json.
- Use \`bun alchemy deploy\` (or the npm/pnpm/yarn equivalent).
- If I'm migrating from Alchemy v1 (async/await), read https://v2.alchemy.run/guides/migrating-from-v1 first.`;
