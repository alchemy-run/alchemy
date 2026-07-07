Build me a pastebin product with both a frontend using TanStack Start and a
backend using alchemy effect workers. Store everything in Durable Objects
(or D1, whatever makes sense). Someone should be able to paste some text,
click share, get a link, and send that link to a friend who sees the paste.
Pastes need to stick around — if I come back tomorrow the link still works.

I want tests too — use alchemy's test harness so `bun vitest run` proves
the deployed thing actually works.

Alchemy docs: {{DOCS}} (there's an llms.txt at {{DOCS}}/llms.txt).

---

Environment notes (from the platform, not the customer):

- Deploy for real, non-interactively: `bun alchemy deploy --stage {{STAGE}} --yes`.
  Use `Alchemy.localState()` as the Stack's state store.
- When writing tests, skip teardown when `NO_DESTROY` is set (it is, during
  grading) so the deployment survives your test run.
- Your Stack must output the deployed site's public URL as `{ url: string }`.
- Credentials are already in env (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
  Never run interactive commands (`alchemy dev`, `alchemy login`).
- Leave the deployment live when you finish — do NOT destroy it. Reviewers
  will exercise the product at the deployed URL and destroy it afterwards.
