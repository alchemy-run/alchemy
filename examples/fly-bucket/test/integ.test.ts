import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

const hasFlyCreds = !!process.env.FLY_API_TOKEN;

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
        times: 20,
      }),
    );
  });

const stack = hasFlyCreds
  ? beforeAll(deploy(Stack), { timeout: 300_000 })
  : null;

afterAll.skipIf(!hasFlyCreds || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

test.skipIf(!hasFlyCreds)(
  "attaches a Tigris bucket and serves its name",
  Effect.gen(function* () {
    const out = yield* stack!;
    expect(out.addOnId).toBeString();
    expect(out.bucketName).toBeString();
    expect(out.apiUrl).toBe(`https://${out.appName}.fly.dev`);

    const health = yield* fetchOk(`${out.apiUrl}/health`);
    expect(health.status).toBe(200);

    const response = yield* fetchOk(`${out.apiUrl}/`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { ok: boolean; bucket: string };
    expect(body.ok).toBe(true);
    expect(body.bucket).toBe(out.bucketName);
  }),
  { timeout: 180_000 },
);
