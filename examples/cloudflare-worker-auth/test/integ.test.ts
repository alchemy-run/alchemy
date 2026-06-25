import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  stage: "test",
});

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

const { executeWhenReady } = Test;

/**
 * Regression guard for https://github.com/alchemy-run/alchemy-effect/pull/598
 *
 * The bearer token is symmetric:
 *
 *  - Stack output: `authToken.text` is an `Output<Redacted<string>>`. It must
 *    be unwrapped via `Output.map(Redacted.value)` before being returned —
 *    otherwise it JSON-serializes to the literal string "<redacted>".
 *  - Worker check: `Cloudflare.Secret.bind(...)` resolves to `Redacted<string>`.
 *    The comparison must unwrap with `Redacted.value(expected)` — otherwise it
 *    compares against "Bearer <redacted>".
 *
 * Two bugs that cancelled: a publisher reading the broken `<redacted>` output
 * would send `Bearer <redacted>`, which the broken worker check also produced,
 * so they matched. This suite breaks that camouflage:
 *
 *  - The output must be the real token, not "<redacted>".
 *  - A request carrying the literal "<redacted>" must be rejected.
 */
test(
  "stack output emits the real token, not the literal <redacted>",
  Effect.gen(function* () {
    const { authToken } = yield* stack;
    expect(authToken).toBeString();
    expect(authToken).not.toBe("<redacted>");
    // Random defaults to 32 bytes -> 64 hex chars.
    expect(authToken).toMatch(/^[0-9a-f]{64}$/);
  }),
);

test(
  "valid token is accepted; invalid / missing / <redacted> are rejected",
  Effect.gen(function* () {
    const { url, authToken } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    const protectedUrl = `${url}/protected`;
    const get = (req: HttpClientRequest.HttpClientRequest) =>
      client.execute(req);

    // Valid token -> 200. `Test.executeWhenReady` rides out the fresh-deploy
    // cold-start window: a `404` while the route propagates, or a `500` while
    // the Secrets Store binding is still settling. Deliberate `401`s (below)
    // are NOT in that window, so they're observed immediately.
    const ok = yield* executeWhenReady(
      HttpClientRequest.get(protectedUrl).pipe(
        HttpClientRequest.bearerToken(authToken),
      ),
    );
    expect(ok.status).toBe(200);

    // Invalid token -> 401
    const bad = yield* get(
      HttpClientRequest.get(protectedUrl).pipe(
        HttpClientRequest.bearerToken("not-the-token"),
      ),
    );
    expect(bad.status).toBe(401);

    // No Authorization header -> 401
    const none = yield* get(HttpClientRequest.get(protectedUrl));
    expect(none.status).toBe(401);

    // The literal "<redacted>" (what both old bugs produced) -> 401.
    // Pre-fix this matched and returned 200.
    const redacted = yield* get(
      HttpClientRequest.get(protectedUrl).pipe(
        HttpClientRequest.bearerToken("<redacted>"),
      ),
    );
    expect(redacted.status).toBe(401);
  }),
  { timeout: 120_000 },
);
