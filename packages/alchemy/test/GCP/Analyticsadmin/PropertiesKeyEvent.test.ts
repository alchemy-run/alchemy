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
  waitUntilKeyEventGone,
  waitUntilPropertyGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getPropertiesKeyEvents on a missing key event fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.getPropertiesKeyEvents({
          name: "properties/0/keyEvents/0",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ANALYTICSADMIN)(
  "createPropertiesKeyEvents without Analytics Admin access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        analytics.createPropertiesKeyEvents({
          parent: "properties/0",
          body: {
            eventName: "alc_key_probe",
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
  "create, update, and delete a key event",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const account = yield* resolveAccountName();
      expect(account).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const property = yield* GCP.Analyticsadmin.Property("Site", {
            parent: account!,
            displayName: "Alchemy key event property",
            timeZone: "America/Chicago",
          });
          const keyEvent = yield* GCP.Analyticsadmin.PropertiesKeyEvent(
            "Signup",
            {
              parent: property.name,
              eventName: "alc_key_signup",
              countingMethod: "ONCE_PER_EVENT",
            },
          );
          return { property, keyEvent };
        }),
      );

      expect(created.keyEvent.name).toContain("/keyEvents/");
      expect(created.keyEvent.eventName).toEqual("alc_key_signup");
      expect(created.keyEvent.countingMethod).toEqual("ONCE_PER_EVENT");

      const fetched = yield* analytics.getPropertiesKeyEvents({
        name: created.keyEvent.name,
      });
      expect(fetched.name).toEqual(created.keyEvent.name);
      expect(fetched.eventName).toEqual("alc_key_signup");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const property = yield* GCP.Analyticsadmin.Property("Site", {
            parent: account!,
            propertyId: created.property.propertyId,
            displayName: "Alchemy key event property",
            timeZone: "America/Chicago",
          });
          const keyEvent = yield* GCP.Analyticsadmin.PropertiesKeyEvent(
            "Signup",
            {
              parent: property.name,
              keyEventId: created.keyEvent.keyEventId,
              eventName: "alc_key_signup",
              countingMethod: "ONCE_PER_SESSION",
            },
          );
          return { property, keyEvent };
        }),
      );

      expect(updated.keyEvent.name).toEqual(created.keyEvent.name);
      expect(updated.keyEvent.countingMethod).toEqual("ONCE_PER_SESSION");

      yield* stack.destroy();

      const keyGone = yield* waitUntilKeyEventGone(created.keyEvent.name);
      expect(keyGone).toEqual("gone");
      const propertyGone = yield* waitUntilPropertyGone(created.property.name);
      expect(propertyGone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
