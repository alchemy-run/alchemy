import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as functions from "@distilled.cloud/stackit/functions";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
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

/** A `200`, once fresh functions answer. */
const getOk = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.succeed(response) : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-service-to-service", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, gatewayId, quotesId } = deployed;

      for (const functionId of [gatewayId, quotesId]) {
        const fn = yield* functions.getFunction({ projectId, functionId }).pipe(
          Effect.as("found"),
          Effect.catchTag("NotFound", () => Effect.succeed("gone")),
          Effect.provide(StackitCloud),
        );
        expect(fn).toEqual("gone");
      }
    }),
    { timeout: 900_000 },
  );

  test(
    "the gateway serves on its own URL",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* getOk(`${url}/`);
      expect(yield* response.text).toEqual("ok");
    }),
    { timeout: 300_000 },
  );

  test(
    "the gateway forwards to the other function",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* getOk(`${url}/quote?n=1`);
      expect((yield* response.json) as { index: number; servedBy: string }).toMatchObject({
        index: 1,
        servedBy: "quotes",
      });
    }),
    { timeout: 300_000 },
  );

  test(
    "both functions are active, each on a revision of its own",
    Effect.gen(function* () {
      const { projectId, gatewayId, quotesId } = yield* stack;
      const [gateway, quotes] = yield* Effect.forEach([gatewayId, quotesId], (functionId) =>
        functions.getFunction({ projectId, functionId }),
      ).pipe(Effect.provide(StackitCloud));
      expect(gateway!.state).toEqual("ACTIVE");
      expect(quotes!.state).toEqual("ACTIVE");
      expect(gateway!.current_revision).not.toEqual(quotes!.current_revision);
    }),
    { timeout: 120_000 },
  );
});
