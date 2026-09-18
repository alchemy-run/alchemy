import * as Alchemy from "alchemy";
import * as GCP from "alchemy/GCP";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { spawnSync } from "node:child_process";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: GCP.providers(),
  state: Alchemy.localState(),
});

const { getWhenReady } = Test;

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

// Both hosts are built from `main`, which needs a local image build.
const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

const skip = !hasGcpCreds || !dockerAvailable;

const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 600_000,
});

const baseUrlOf = (url: string | undefined) => {
  if (url === undefined) throw new Error("the service has no URL");
  return url.replace(/\/+$/, "");
};

const publish = (baseUrl: string, type: string, payload: unknown) =>
  HttpClient.execute(
    HttpClientRequest.post(`${baseUrl}/events`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ type, payload }),
    ),
  );

const countOf = (baseUrl: string, type: string) =>
  Effect.gen(function* () {
    const res = yield* HttpClient.execute(
      HttpClientRequest.get(
        `${baseUrl}/events/count?type=${encodeURIComponent(type)}`,
      ),
    );
    return ((yield* res.json) as { count: number }).count;
  });

test.skipIf(skip)(
  "accepts events without touching BigQuery on the request path",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toMatch(/^https:\/\//);
    const baseUrl = baseUrlOf(url);
    yield* getWhenReady(`${baseUrl}/`);

    const accepted = yield* publish(baseUrl, "integ.smoke", { n: 1 });
    expect(accepted.status).toBe(202);
    const { id } = (yield* accepted.json) as { id: string };
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const missingType = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/events`).pipe(
        HttpClientRequest.bodyJsonUnsafe({ payload: {} }),
      ),
    );
    expect(missingType.status).toBe(400);
  }),
  { timeout: 180_000 },
);

test.skipIf(skip)(
  "the drain job moves published events into BigQuery",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const baseUrl = baseUrlOf(url);
    yield* getWhenReady(`${baseUrl}/`);

    // A unique type keeps the count independent of other runs against the
    // same project.
    const type = `integ.drain.${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i++) {
      const res = yield* publish(baseUrl, type, { i });
      expect(res.status).toBe(202);
    }

    expect(yield* countOf(baseUrl, type)).toBe(0);

    const drain = yield* HttpClient.execute(
      HttpClientRequest.post(`${baseUrl}/drain`),
    );
    expect(drain.status).toBe(202);

    // Starting a Cloud Run Job returns immediately; the rows show up once
    // the execution finishes and BigQuery's streaming buffer is queryable.
    const landed = yield* countOf(baseUrl, type).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (count) => count >= 3,
        times: 24,
      }),
    );
    expect(landed).toBeGreaterThanOrEqual(3);
  }),
  { timeout: 600_000 },
);
