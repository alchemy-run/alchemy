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
import Stack, { GREETING } from "../alchemy.run.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Stackit.providers(),
  state: Alchemy.localState(),
  profile: process.env.ALCHEMY_PROFILE,
});

// Out-of-band calls resolve the same profile the deploy uses.
const StackitCloud = Layer.mergeAll(Stackit.StackitAuth, Stackit.fromAuthProvider()).pipe(
  Layer.provideMerge(FetchHttpClient.layer),
);

describe("stackit-server", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, serverId, networkId } = deployed;

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

      const network = yield* iaas.getNetwork({ projectId, region, networkId }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (state) => state === "gone",
          times: 10,
        }),
        Effect.provide(StackitCloud),
      );
      expect(network).toEqual("gone");
    }),
    { timeout: 900_000 },
  );

  test(
    "the server is active",
    Effect.gen(function* () {
      const { projectId, region, serverId } = yield* stack;
      const server = yield* iaas
        .getServer({ projectId, region, serverId })
        .pipe(Effect.provide(StackitCloud));
      expect(server.status).toEqual("ACTIVE");
      expect(server.machineType).toEqual("g1.1");
    }),
    { timeout: 120_000 },
  );

  test(
    "cloud-init started the web server on the public address",
    Effect.gen(function* () {
      const { url } = yield* stack;
      // `runcmd` runs late in the first boot, so the address answers some time after `ACTIVE`.
      const response = yield* HttpClient.get(`${url}/`).pipe(
        Effect.timeout("10 seconds"),
        Effect.flatMap((res) =>
          res.status === 200 ? Effect.succeed(res) : Effect.fail(`HTTP ${res.status}`),
        ),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 42 }),
      );
      expect(yield* response.text).toEqual(GREETING);
    }),
    { timeout: 600_000 },
  );
});
