import { expect } from "bun:test";
import * as Modal from "@alchemy.run/modal";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Modal.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "a web function calls another function",
  Effect.gen(function* () {
    const { api } = yield* stack;
    const response = yield* Test.getWhenReady(`${api}?text=hello%20modal%20functions`);
    expect(response.status).toBe(200);
    expect(yield* response.json).toEqual({ text: "hello modal functions", tokens: 3 });
  }),
  { timeout: 900_000 },
);

test(
  "a public server reports the function's load",
  Effect.gen(function* () {
    const { status } = yield* stack;
    const response = yield* Test.getWhenReady(`${status}`);
    expect(response.status).toBe(200);
    const stats = (yield* response.json) as { backlog: number };
    expect(stats.backlog).toBeGreaterThanOrEqual(0);
  }),
  { timeout: 600_000 },
);
