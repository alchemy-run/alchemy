import * as Alchemy from "alchemy";
import * as Fly from "alchemy/Fly";
import * as Test from "alchemy/Test/Bun";
import { expect } from "bun:test";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";
import { SECRET_NAME } from "../src/shared.ts";

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
  "deploys Api + Worker and serves /health over fly.dev",
  Effect.gen(function* () {
    const out = yield* stack!;
    expect(out.appName).toBeString();
    expect(out.apiUrl).toBe(`https://${out.appName}.fly.dev`);
    expect(out.ip).toBeString();
    expect(out.secretName).toBe(SECRET_NAME);
    expect(out.workerMounts[0]?.volumeId).toBeString();
    expect(out.apiMachineId).not.toBe(out.workerMachineId);

    const health = yield* getWhenReady(`${out.apiUrl}/health`);
    expect(health.status).toBe(200);
    const body = (yield* health.json) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe(SECRET_NAME);
  }),
  { timeout: 180_000 },
);

test.skipIf(!hasFlyCreds)(
  "GetSecret returns the App secret name over /secret",
  Effect.gen(function* () {
    const out = yield* stack!;
    const response = yield* getWhenReady(`${out.apiUrl}/secret`);
    expect(response.status).toBe(200);
    const body = (yield* response.json) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe(SECRET_NAME);
  }),
  { timeout: 120_000 },
);
