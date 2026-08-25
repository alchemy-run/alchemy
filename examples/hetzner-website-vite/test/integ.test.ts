import * as Alchemy from "alchemy";
import * as Hetzner from "alchemy/Hetzner";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Hetzner.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const fetchOk = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new Error(`HTTP ${res.status}`)),
      ),
      Effect.retry({
        schedule: Schedule.exponential("500 millis"),
        times: 10,
      }),
    );
  });

if (!hasHetznerCreds) {
  test.skip("skipped without HCLOUD_TOKEN", Effect.void);
} else {
  const stack = beforeAll(deploy(Stack), { timeout: 120_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
    timeout: 120_000,
  });

  test(
    "deploys and exposes a url",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toBeString();
      expect(url).toMatch(/^http:\/\//);
    }).pipe(
      Effect.catchTag(["PreconditionFailed", "Forbidden"], (error) =>
        Effect.logWarning(`skipping: Hetzner quota (${error._tag})`),
      ),
    ),
    { timeout: 120_000 },
  );

  test(
    "serves the Vite SPA",
    Effect.gen(function* () {
      const { url } = yield* stack;
      if (!url) throw new Error("expected the site to expose a url");
      const base = String(url).replace(/\/+$/, "");
      const response = yield* fetchOk(`${base}/`);
      expect(response.status).toBe(200);
      const body = yield* response.text;
      expect(body).toContain("HETZNER_VITE_PAGE_MARKER");
    }).pipe(
      Effect.catchTag(["PreconditionFailed", "Forbidden"], (error) =>
        Effect.logWarning(`skipping: Hetzner quota (${error._tag})`),
      ),
    ),
    { timeout: 120_000 },
  );

  test(
    "answers GET /health",
    Effect.gen(function* () {
      const { url } = yield* stack;
      if (!url) throw new Error("expected the site to expose a url");
      const base = String(url).replace(/\/+$/, "");
      const response = yield* fetchOk(`${base}/health`);
      expect(response.status).toBe(200);
      const body = yield* response.text;
      expect(body).toContain("ok");
    }).pipe(
      Effect.catchTag(["PreconditionFailed", "Forbidden"], (error) =>
        Effect.logWarning(`skipping: Hetzner quota (${error._tag})`),
      ),
    ),
    { timeout: 120_000 },
  );
}
