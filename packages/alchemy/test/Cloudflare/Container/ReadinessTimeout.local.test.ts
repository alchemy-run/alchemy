import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import TimeoutWorker from "./fixtures/readiness-timeout/worker.ts";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
  dev: true,
});

test.provider(
  "hung real container probes respect the complete readiness deadline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const worker = yield* stack.deploy(TimeoutWorker);
      const client = yield* HttpClient.HttpClient;
      const started = Date.now();
      const response = yield* client
        .get(new URL("/hello", worker.url))
        .pipe(Effect.timeout("40 seconds"));
      const elapsed = Date.now() - started;
      expect(response.status).toEqual(503);
      const body = yield* response.text;
      expect(body).toContain("did not become ready within 20000ms");
      expect(elapsed).toBeLessThan(35_000);
      yield* stack.destroy();
    }),
  { timeout: 120_000, retry: 0 },
);
