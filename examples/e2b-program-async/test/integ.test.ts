import { expect } from "bun:test";
import * as E2B from "@alchemy.run/e2b";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: E2B.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "the plain handler serves with its env from the declared sandbox",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const res = yield* Test.executeWhenReady(HttpClientRequest.get(`${url}/?name=e2b`));
    expect(res.status).toBe(200);
    expect(yield* res.json).toEqual({ message: "hello, e2b" });
  }),
  { timeout: 180_000 },
);
