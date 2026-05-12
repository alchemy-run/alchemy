export const AGENT_PROMPT = `Help me build an Alchemy app on Cloudflare. Start by fetching https://v2.alchemy.run/llms.txt — it's the index of every doc, tutorial, and guide on the site. Use it to look up the specific page you need at each step instead of guessing URLs or loading docs you don't need.

First, read https://v2.alchemy.run/getting-started and follow it exactly: scaffold a fresh project, install the dependencies, create the \`alchemy.run.ts\` Stack with a single Cloudflare R2 Bucket (no Worker yet), and run \`alchemy deploy\` so I sign in to Cloudflare and provision the Bucket. Confirm the Bucket is live before moving on.

Then STOP and ASK ME what I want to build. From there, consult llms.txt to find the relevant tutorial / guide / concept page for what I asked for, and fetch only those — don't march me through every tutorial. A Worker only gets added later if what I want to build needs one.

Important:
- Always consult https://v2.alchemy.run/llms.txt before fetching docs — it's faster than searching and keeps you on canonical URLs.
- Confirm with me before each deploy. Don't batch.
- Do NOT instruct me to export CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. Alchemy stores credentials in profiles — \`alchemy login\` (or the first \`alchemy deploy\`) prompts interactively for OAuth or an API token and saves it to ~/.alchemy/profiles.json.
- Use \`bun alchemy deploy\` (or the npm/pnpm/yarn equivalent).
- If I'm migrating from Alchemy v1 (async/await), find the v1 migration guide via llms.txt and read it first.`;
