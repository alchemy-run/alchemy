export const AGENT_PROMPT = `Read https://v2.alchemy.run/getting-started and help me scaffold an Alchemy app.

Then walk me through the tutorial at https://v2.alchemy.run/tutorial/part-1 — it picks up exactly where getting-started leaves off and adds a Worker, bindings, secrets, stages, and CI/CD. Follow the tutorial parts in order (part-1 → part-5) rather than jumping ahead to provider reference pages.

Important:
- Do NOT instruct me to export CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN. Alchemy stores credentials in profiles — running \`alchemy deploy\` (or \`alchemy login\`) the first time will interactively prompt for OAuth or an API token and save it to ~/.alchemy/profiles.json.
- Use \`bun alchemy deploy\` (or the npm/pnpm/yarn equivalent) to deploy.
- If I'm migrating from Alchemy v1 (async/await), check https://v2.alchemy.run/guides/migrating-from-v1 first.`;
