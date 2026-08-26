import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as analytics from "@distilled.cloud/gcp/analyticsadmin_v1beta";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  resolveAccountName,
  runLifecycle,
  waitUntilPropertyGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getProperties on a missing property fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.getProperties({ name: "properties/0" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ANALYTICSADMIN)(
  "createProperties without Analytics Admin access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.createProperties({
          body: {
            parent: "accounts/0",
            displayName: "Alchemy Analyticsadmin Probe",
            timeZone: "America/Chicago",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a property",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* resolveAccountName();
      expect(parent).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Analyticsadmin.Property("Site", {
            parent: parent!,
            displayName: "Alchemy site",
            timeZone: "America/Chicago",
            currencyCode: "USD",
          });
        }),
      );

      expect(created.name.startsWith("properties/")).toEqual(true);
      expect(created.propertyId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("Alchemy site");
      expect(created.timeZone).toEqual("America/Chicago");
      expect(created.parent).toEqual(parent);

      const fetched = yield* analytics.getProperties({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.displayName).toContain("Alchemy site");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Analyticsadmin.Property("Site", {
            parent: parent!,
            propertyId: created.propertyId,
            displayName: "Alchemy site 2026",
            timeZone: "America/New_York",
            currencyCode: "USD",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Alchemy site 2026");
      expect(updated.timeZone).toEqual("America/New_York");

      yield* stack.destroy();

      const gone = yield* waitUntilPropertyGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
