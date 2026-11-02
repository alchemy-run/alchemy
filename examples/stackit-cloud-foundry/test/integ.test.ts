import { describe, expect } from "bun:test";
import * as Stackit from "@alchemy.run/stackit";
import * as Test from "@alchemy.run/test/Bun";
import * as scf from "@distilled.cloud/stackit/scf";
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

/** A route's first answers can be the router's 404, until it has picked up the app. */
const getOk = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.timeout("20 seconds"),
    Effect.flatMap((response) =>
      response.status === 200 ? Effect.succeed(response) : Effect.fail(`HTTP ${response.status}`),
    ),
    Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 24 }),
  );

describe("stackit-cloud-foundry", () => {
  const stack = beforeAll(deploy(Stack), { timeout: 1_500_000 });

  afterAll.skipIf(!!process.env.NO_DESTROY)(
    Effect.gen(function* () {
      const deployed = yield* stack;
      yield* destroy(Stack);

      // A failed deploy returns nothing, but the destroy above still removes what it made.
      if (deployed === undefined) return;
      const { projectId, region, organizationId } = deployed;

      const organization = yield* scf.getOrganization({ projectId, region, organizationId }).pipe(
        Effect.as("found"),
        Effect.catchTag("NotFound", () => Effect.succeed("gone")),
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (state) => state === "gone",
          times: 24,
        }),
        Effect.provide(StackitCloud),
      );
      expect(organization).toEqual("gone");
    }),
    { timeout: 900_000 },
  );

  test(
    "the effect app serves its variable",
    Effect.gen(function* () {
      const { url } = yield* stack;
      const response = yield* getOk(`${url}/`);
      expect(yield* response.text).toEqual("hello from an effect app");
    }),
    { timeout: 300_000 },
  );

  test(
    "the async app serves its variable",
    Effect.gen(function* () {
      const { webUrl } = yield* stack;
      const response = yield* getOk(`${webUrl}/`);
      expect(yield* response.text).toEqual("hello from an async app");
    }),
    { timeout: 300_000 },
  );

  test(
    "a binding reads the space with the created key, and it matches the API",
    Effect.gen(function* () {
      const { url, projectId, region, organizationId, spaceId } = yield* stack;
      const response = yield* getOk(`${url}/space`);
      const body = (yield* response.json) as { spaceId: string; name: string };

      const space = yield* scf
        .getSpace({ projectId, region, organizationId, spaceId })
        .pipe(Effect.provide(StackitCloud));
      expect(body).toEqual({ spaceId: space.guid, name: space.name });
    }),
    { timeout: 300_000 },
  );
});
