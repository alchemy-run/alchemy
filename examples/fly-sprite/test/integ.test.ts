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
const entitled = !!process.env.FLY_TEST_SPRITES;
const { getWhenReady } = Test;

const stack =
  hasFlyCreds && entitled
    ? beforeAll(deploy(Stack), { timeout: 180_000 })
    : null;

afterAll.skipIf(!hasFlyCreds || !entitled || !!process.env.NO_DESTROY)(
  destroy(Stack),
  { timeout: 120_000 },
);

test.skipIf(!hasFlyCreds || !entitled)(
  "deploys an effectful Sprite and serves HTTP",
  Effect.gen(function* () {
    const out = yield* stack!;
    expect(out.spriteId).toBeString();
    expect(out.name).toBeString();
    expect(out.url).toBeString();
    expect(out.url).toContain("sprites.app");
    expect(out.urlAuth).toBe("public");

    const health = yield* getWhenReady(`${out.url}/health`);
    expect(health.status).toBe(200);
    const body = (yield* health.json) as { ok: boolean };
    expect(body.ok).toBe(true);
  }),
  { timeout: 120_000 },
);
