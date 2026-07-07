Build me a pastebin product with both a frontend using TanStack Start and a
backend using alchemy effect workers. Store everything in Durable Objects
(or D1, whatever makes sense). Someone should be able to paste some text,
click share, get a link, and send that link to a friend who sees the paste.
Pastes need to stick around — if I come back tomorrow the link still works.

I want tests too — use alchemy's test harness (`Test.make` with
`beforeAll(deploy(...))` / `afterAll(destroy(...))`) so `bun vitest run`
proves the deployed thing actually works.

Alchemy docs: {{DOCS}} (there's an llms.txt at {{DOCS}}/llms.txt).

---

Environment notes (from the platform, not the customer):

- Deploy for real, non-interactively: `bun alchemy deploy --stage {{STAGE}} --yes`.
  The project is pre-configured with `Alchemy.localState()`; keep it.
- Your Stack must output the deployed site's public URL as `{ url: string }`.
- Credentials are already in env (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
  Never run interactive commands (`alchemy dev`, `alchemy login`).
- Leave the deployment live when you finish — do NOT destroy it. Reviewers
  will exercise the product at the deployed URL and destroy it afterwards.
