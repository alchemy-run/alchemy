import { expect } from "bun:test";
import * as E2B from "@alchemy.run/e2b";
import * as Test from "@alchemy.run/test/Bun";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: E2B.providers(),
  state: Alchemy.localState(),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const { executeWhenReady } = Test;

/** Out-of-band E2B calls, with the profile's credentials. */
const E2BHttp = Layer.mergeAll(E2B.E2BAuth, E2B.fromAuthProvider(), FetchHttpClient.layer);
const stateOf = (sandboxId: string) =>
  sandboxes.getSandbox({ sandboxID: sandboxId }).pipe(
    Effect.map((detail) => detail.state),
    Effect.provide(E2BHttp),
  );

const visits = (url: string) =>
  Effect.gen(function* () {
    const res = yield* executeWhenReady(HttpClientRequest.get(url));
    expect(res.status).toBe(200);
    return ((yield* res.json) as { visits: number }).visits;
  });

test(
  "the program keeps its memory across a pause and resumes on a request",
  Effect.gen(function* () {
    const { url, sandboxId } = yield* stack;
    const first = yield* visits(url);
    expect(yield* visits(url)).toBe(first + 1);

    // Paused, as on its timeout: the next request resumes it where it left off.
    yield* sandboxes.pauseSandbox({ sandboxID: sandboxId }).pipe(Effect.provide(E2BHttp));
    expect(yield* stateOf(sandboxId)).toBe("paused");
    expect(yield* visits(url)).toBe(first + 2);
    expect(yield* stateOf(sandboxId)).toBe("running");
  }),
  { timeout: 180_000 },
);
