# pastebin

You are building and DEPLOYING a real application with the Alchemy framework.
Documentation: {{DOCS}} (start at {{DOCS}}/llms.txt).

## Product spec

A minimal pastebin API. Users create text pastes and read them back by id.
Pastes are stored durably in a SQL database and survive across requests and
Worker restarts. There is no UI — this is an HTTP API only.

## Required interface (machine-checked — do not deviate)

- Stack outputs: your `alchemy.run.ts` default-export Stack MUST return exactly
  `{ url: string }` — the deployed Worker's public URL.
- HTTP contract:

| Method | Path          | Behavior                                                                 |
|--------|---------------|--------------------------------------------------------------------------|
| GET    | `/health`     | `200` JSON `{ "ok": true }`                                              |
| POST   | `/pastes`     | body `{ "content": string }` → `201` JSON `{ "id": string, "url": string }` |
| GET    | `/pastes/:id` | `200` JSON `{ "id": string, "content": string, "createdAt": string }` or `404` JSON `{ "error": "not_found" }` |

- `id` is URL-safe and at least 8 characters; each paste gets a distinct id.
- `url` in the POST response is the absolute URL of `GET /pastes/:id`.
- `createdAt` is an ISO-8601 timestamp.

## Constraints

- Cloudflare Worker + Cloudflare D1 for storage. Do NOT use KV.
- The template already configures `Alchemy.localState()` and the stage.
  Deploy non-interactively with:
  `bun alchemy deploy --stage {{STAGE}} --yes`
- Credentials are already in the environment (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`); never prompt for login or ask for input.
- Do not run interactive commands (`alchemy dev`, `alchemy login`).

## Tests (required — drive your development with them)

Write live tests for every behavior in the Required interface using alchemy's
test harness: `Test.make({ providers, stage })` with `beforeAll(deploy(Stack))`
and `afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack))`, one deploy
shared across the file, requests driven via `HttpClient`, and bounded retries
(`Effect.retry` with a `Schedule`). The included `test/smoke.test.ts` shows the
pattern — extend the suite in your own files under `test/`; do not edit
`smoke.test.ts` itself.

## Definition of done

1. `./node_modules/.bin/tsc -p .` passes.
2. `bun alchemy deploy --stage {{STAGE}} --yes` completes green; a second run
   reports no changes.
3. Your own test suite covers the full Required interface and
   `bun vitest run` passes (smoke.test.ts included).
4. The deployment stays live when you finish — do NOT destroy it; graders
   destroy it after scoring.
