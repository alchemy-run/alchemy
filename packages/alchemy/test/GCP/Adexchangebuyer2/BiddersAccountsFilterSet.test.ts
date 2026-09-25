import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as adex from "@distilled.cloud/gcp/adexchangebuyer2_v2beta1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  logLevel,
  probeAccountOwner,
  runAccountsLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  adex.getBiddersAccountsFilterSets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getBiddersAccountsFilterSets on a missing filter set fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        adex.getBiddersAccountsFilterSets({
          name: `${probeAccountOwner}/filterSets/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ADEXCHANGEBUYER2)(
  "createBiddersAccountsFilterSets without Authorized Buyers access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        adex.createBiddersAccountsFilterSets({
          ownerName: probeAccountOwner,
          body: {
            name: `${probeAccountOwner}/filterSets/alchemy-adx-acct-probe`,
            relativeDateRange: { offsetDays: 0, durationDays: 1 },
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runAccountsLifecycle)(
  "create, replace, and delete an account filter set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Adexchangebuyer2.BiddersAccountsFilterSet("Seat", {
            ownerName: probeAccountOwner,
            environment: "WEB",
            relativeDateRange: { offsetDays: 0, durationDays: 1 },
          });
        }),
      );

      expect(created.name).toContain("/accounts/");
      expect(created.name).toContain("/filterSets/");
      expect(created.ownerName).toEqual(probeAccountOwner);
      expect(created.filterSetId.startsWith("alch.")).toEqual(true);
      expect(created.environment).toEqual("WEB");

      const fetched = yield* adex.getBiddersAccountsFilterSets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.environment).toEqual("WEB");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Adexchangebuyer2.BiddersAccountsFilterSet("Seat", {
            ownerName: created.ownerName,
            filterSetId: created.filterSetId,
            environment: "APP",
            relativeDateRange: { offsetDays: 0, durationDays: 1 },
          });
        }),
      );

      expect(updated.ownerName).toEqual(created.ownerName);
      expect(updated.environment).toEqual("APP");

      const fetchedUpdate = yield* adex.getBiddersAccountsFilterSets({
        name: updated.name,
      });
      expect(fetchedUpdate.environment).toEqual("APP");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
