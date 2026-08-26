import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as cloudidentity from "@distilled.cloud/gcp/cloudidentity_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { customer, hasGcpCreds, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  cloudidentity.getDevices({ name, customer }).pipe(
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
  "getDevices on a missing device fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.getDevices({
          name: "devices/alchemy-missing-device",
          customer,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CLOUDIDENTITY)(
  "createDevices without Cloud Identity Premium fails with a typed entitlement error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        cloudidentity.createDevices({
          customer,
          body: {
            serialNumber: "alchemy-probe-device",
            deviceType: "LINUX",
            assetTag: "alchemy-probe",
          },
        }),
      );
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a company-owned device",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Cloudidentity.Device("Laptop", {
            customer,
            deviceType: "LINUX",
            hostname: "eng-laptop",
            assetTag: "desk-14",
          });
        }),
      );

      expect(created.name.startsWith("devices/")).toEqual(true);
      expect(created.serialNumber?.length).toBeGreaterThan(0);
      expect(created.assetTag).toEqual("desk-14");

      const fetched = yield* cloudidentity.getDevices({
        name: created.name,
        customer,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.assetTag).toContain("[alchemy ");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
