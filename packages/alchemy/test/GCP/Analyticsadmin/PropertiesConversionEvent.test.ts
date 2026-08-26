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
  waitUntilConversionEventGone,
  waitUntilPropertyGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getPropertiesConversionEvents on a missing conversion event fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.getPropertiesConversionEvents({
          name: "properties/0/conversionEvents/0",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ANALYTICSADMIN)(
  "createPropertiesConversionEvents without Analytics Admin access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.createPropertiesConversionEvents({
          parent: "properties/0",
          body: {
            eventName: "alc_probe",
            countingMethod: "ONCE_PER_EVENT",
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a conversion event",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* resolveAccountName();
      expect(account).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const property = yield* GCP.Analyticsadmin.Property("Site", {
            parent: account!,
            displayName: "Alchemy conversion property",
            timeZone: "America/Chicago",
          });
          const conversion =
            yield* GCP.Analyticsadmin.PropertiesConversionEvent("Signup", {
              parent: property.name,
              eventName: "alc_signup",
              countingMethod: "ONCE_PER_EVENT",
            });
          return { property, conversion };
        }),
      );

      expect(created.conversion.name).toContain("/conversionEvents/");
      expect(created.conversion.eventName).toEqual("alc_signup");
      expect(created.conversion.countingMethod).toEqual("ONCE_PER_EVENT");

      const fetched = yield* analytics.getPropertiesConversionEvents({
        name: created.conversion.name,
      });
      expect(fetched.name).toEqual(created.conversion.name);
      expect(fetched.eventName).toEqual("alc_signup");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const property = yield* GCP.Analyticsadmin.Property("Site", {
            parent: account!,
            propertyId: created.property.propertyId,
            displayName: "Alchemy conversion property",
            timeZone: "America/Chicago",
          });
          const conversion =
            yield* GCP.Analyticsadmin.PropertiesConversionEvent("Signup", {
              parent: property.name,
              conversionEventId: created.conversion.conversionEventId,
              eventName: "alc_signup",
              countingMethod: "ONCE_PER_SESSION",
            });
          return { property, conversion };
        }),
      );

      expect(updated.conversion.name).toEqual(created.conversion.name);
      expect(updated.conversion.countingMethod).toEqual("ONCE_PER_SESSION");

      yield* stack.destroy();

      const conversionGone = yield* waitUntilConversionEventGone(
        created.conversion.name,
      );
      expect(conversionGone).toEqual("gone");
      const propertyGone = yield* waitUntilPropertyGone(created.property.name);
      expect(propertyGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
