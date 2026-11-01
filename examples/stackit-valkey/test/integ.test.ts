import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as valkey from "@distilled.cloud/stackit/valkey";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import Stack from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

/** A request that has to answer `200`, retried while a fresh function and its login settle. */
const expectOk = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.succeed(response) : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-valkey", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 2_700_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, instanceId } = deployed;

      const instance = yield* valkey.getInstance({ projectId, regionId: region, instanceId }).pipe(
        Effect.as("found"),
        Effect.catchTag(["NotFound", "InstanceGone"], () => Effect.succeed("gone")),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (state) => state === "gone",
          times: 12,
        }),
        Effect.provide(StackitCloud),
      );
      expect(instance).toEqual("gone");
    }),
    { timeout: 1_800_000 },
  );

  test(
    "the function reaches the instance with the bound credential",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* expectOk(HttpClientRequest.get(`${url}/`));
      expect((yield* response.json) as { pong: string }).toEqual({ pong: "PONG" });
    }),
    { timeout: 300_000 },
  );

  test(
    "counts hits in Valkey",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const key = `integ-${crypto.randomUUID()}`;

      const first = yield* expectOk(HttpClientRequest.post(`${url}/hit/${key}`));
      expect((yield* first.json) as { key: string; count: number }).toEqual({ key, count: 1 });

      const second = yield* expectOk(HttpClientRequest.post(`${url}/hit/${key}`));
      expect((yield* second.json) as { key: string; count: number }).toEqual({ key, count: 2 });

      const count = yield* expectOk(HttpClientRequest.get(`${url}/count/${key}`));
      expect((yield* count.json) as { key: string; count: number }).toEqual({ key, count: 2 });
    }),
    { timeout: 300_000 },
  );

  test(
    "the instance is active",
    Effect.gen(function* () {
      const { projectId, region, instanceId } = yield* stack;
      const instance = yield* valkey
        .getInstance({ projectId, regionId: region, instanceId })
        .pipe(Effect.provide(StackitCloud));
      expect(instance.status).toEqual("active");
    }),
    { timeout: 120_000 },
  );
});
