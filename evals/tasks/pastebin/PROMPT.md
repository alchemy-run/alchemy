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
- Use `Alchemy.localState()` as the Stack's state store.
  Deploy non-interactively with:
  `bun alchemy deploy --stage {{STAGE}} --yes`
- Credentials are already in the environment (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`); never prompt for login or ask for input.
- Do not run interactive commands (`alchemy dev`, `alchemy login`).

## Tests (required — drive your development with them)

Write live tests for every behavior in the Required interface using alchemy's
test harness (see the testing docs), with one deploy shared across the file
and teardown skipped when `NO_DESTROY` is set (it is, during grading). Drive
requests via the harness's HTTP client with bounded retries.

## Definition of done

1. `./node_modules/.bin/tsc -p .` passes.
2. `bun alchemy deploy --stage {{STAGE}} --yes` completes green; a second run
   reports no changes.
3. Your test suite covers the full Required interface and
   `bun vitest run` passes.
4. The deployment stays live when you finish — do NOT destroy it; graders
   destroy it after scoring.
