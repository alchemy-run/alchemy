import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
  state: Alchemy.localState(),
});

const hasFlyCreds = !!process.env.FLY_API_TOKEN;
const { getWhenReady } = Test;

const stack = hasFlyCreds
  ? beforeAll(deploy(Stack), { timeout: 300_000 })
  : null;

afterAll.skipIf(!hasFlyCreds || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 180_000,
});

test.skipIf(!hasFlyCreds)(
  "attaches Redis and PING's it from the Service",
  Effect.gen(function* () {
    const out = yield* stack!;
    expect(out.redisId).toBeString();
    expect(out.apiUrl).toBe(`https://${out.appName}.fly.dev`);

    const health = yield* getWhenReady(`${out.apiUrl}/health`);
    expect(health.status).toBe(200);

    const ping = yield* getWhenReady(`${out.apiUrl}/`);
    expect(ping.status).toBe(200);
    const body = (yield* ping.json) as { pong: boolean };
    expect(body.pong).toBe(true);
  }),
  { timeout: 180_000 },
);
