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
const mpgEnabled = !!process.env.FLY_TEST_MPG;
const { getWhenReady } = Test;

const stack =
  hasFlyCreds && mpgEnabled
    ? beforeAll(deploy(Stack), { timeout: 300_000 })
    : null;

afterAll.skipIf(!hasFlyCreds || !mpgEnabled || !!process.env.NO_DESTROY)(
  destroy(Stack),
  { timeout: 180_000 },
);

test.skipIf(!hasFlyCreds || !mpgEnabled)(
  "attaches Managed Postgres and DATABASE_URL is present in the Service",
  Effect.gen(function* () {
    const out = yield* stack!;
    expect(out.clusterId).toBeString();
    expect(out.region).toBe("iad");
    expect(out.apiUrl).toBe(`https://${out.appName}.fly.dev`);

    const health = yield* getWhenReady(`${out.apiUrl}/health`);
    expect(health.status).toBe(200);
    const body = (yield* health.json) as { ok: boolean };
    expect(body.ok).toBe(true);
  }),
  { timeout: 240_000 },
);
