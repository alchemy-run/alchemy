import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as sca from "@distilled.cloud/stackit/sca";
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

/** A `200`, once a fresh application and its grants answer. */
const getOk = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("30 seconds"),
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.succeed(response) : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-container-app", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, environmentId, apiId, webId } = deployed;

      for (const applicationId of [apiId, webId]) {
        const application = yield* sca
          .getApplication({ projectId, region, environmentId, applicationId })
          .pipe(
            Effect.as("found"),
            Effect.catchTag("NotFound", () => Effect.succeed("gone")),
            Effect.provide(StackitCloud),
          );
        expect(application).toEqual("gone");
      }
    }),
    { timeout: 900_000 },
  );

  test(
    "the program serves its variable",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* getOk(`${url}/`);
      expect(yield* response.text).toEqual("hello from a container application");
    }),
    { timeout: 300_000 },
  );

  test(
    "a binding reads the zone with the created key",
    Effect.gen(function* () {
      const { url, zoneId } = yield* stack;
      const response = yield* getOk(`${url}/zone`);
      expect((yield* response.json) as { zoneId: string }).toEqual({ zoneId: zoneId });
    }),
    { timeout: 300_000 },
  );

  test(
    "the public image serves, at a fixed instance count",
    Effect.gen(function* () {
      const { webUrl, projectId, region, environmentId, webId } = yield* stack;
      const response = yield* getOk(`${webUrl}/`);
      expect(yield* response.text).toContain("nginx");

      const web = yield* sca
        .getApplication({ projectId, region, environmentId, applicationId: webId })
        .pipe(Effect.provide(StackitCloud));
      expect(web.status?.current).toEqual("CURRENT_STATUS_RUNNING");
      expect(web.scaling.manualScaling?.instances).toEqual(1);
    }),
    { timeout: 300_000 },
  );
});
