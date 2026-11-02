import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as iaas from "@distilled.cloud/stackit/iaas";
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

/** A `200`, once a fresh address and the binding's grant answer. */
const getOk = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("10 seconds"),
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.succeed(response) : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-service", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_800_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, serverId } = deployed;

      const server = yield* iaas.getServer({ projectId, region, serverId }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (state) => state === "gone",
          times: 10,
        }),
        Effect.provide(StackitCloud),
      );
      expect(server).toEqual("gone");
    }),
    { timeout: 900_000 },
  );

  test(
    "the program serves its variable from the server's public address",
    Effect.gen(function* () {
      const { url } = yield* stack;
      expect(url).toMatch(/^http:\/\/.+:3000$/);
      const response = yield* getOk(`${url}/`);
      expect(yield* response.text).toEqual("hello from a server");
    }),
    { timeout: 300_000 },
  );

  test(
    "a binding signs with a token from the server's metadata API",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* getOk(`${url}/commands`);
      expect(response.status).toBe(200);
    }),
    { timeout: 300_000 },
  );

  test(
    "the server is active, with a service account attached",
    Effect.gen(function* () {
      const { projectId, region, serverId } = yield* stack;
      const server = yield* iaas
        .getServer({ projectId, region, serverId })
        .pipe(Effect.provide(StackitCloud));
      expect(server.status).toEqual("ACTIVE");

      const { items } = yield* iaas
        .listServerServiceAccounts({ projectId, region, serverId })
        .pipe(Effect.provide(StackitCloud));
      expect(items.length).toBe(1);
    }),
    { timeout: 120_000 },
  );
});
