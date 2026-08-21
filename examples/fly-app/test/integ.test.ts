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
  ? beforeAll(deploy(Stack), { timeout: 180_000 })
  : null;

afterAll.skipIf(!hasFlyCreds || !!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

test.skipIf(!hasFlyCreds)(
  "deploys nginx on a Machine and serves over fly.dev",
  Effect.gen(function* () {
    const out = yield* stack!;
    expect(out.url).toBeString();
    expect(out.url).toMatch(/^https:\/\/.+\.fly\.dev$/);
    expect(out.ip).toBeString();
    expect(out.machineId).toBeString();

    const response = yield* getWhenReady(out.url);
    expect(response.status).toBe(200);
  }),
  { timeout: 120_000 },
);
