import { expect } from "bun:test";
import * as Boat from "@alchemy.run/boat";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Boat.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const { executeWhenReady } = Test;

const visits = (url: string) =>
  Effect.gen(function* () {
    const res = yield* executeWhenReady(HttpClientRequest.get(url));
    expect(res.status).toBe(200);
    return ((yield* res.json) as { visits: number }).visits;
  });

test(
  "the program serves at a public URL and counts visits on its disk",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const first = yield* visits(url);
    expect(yield* visits(url)).toBe(first + 1);
  }),
  { timeout: 180_000 },
);
