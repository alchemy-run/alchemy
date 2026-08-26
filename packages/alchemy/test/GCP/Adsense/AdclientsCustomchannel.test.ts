import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as adsense from "@distilled.cloud/gcp/adsense_v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  hasGcpCreds,
  logLevel,
  probeName,
  probeParent,
  resolveParent,
  runLifecycle,
  waitUntilGone,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!hasGcpCreds)(
  "getAccountsAdclientsCustomchannels on a missing custom channel fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        adsense.getAccountsAdclientsCustomchannels({ name: probeName }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_ADSENSE)(
  "createAccountsAdclientsCustomchannels without AdSense for Platforms access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        adsense.createAccountsAdclientsCustomchannels({
          parent: probeParent,
          body: {
            displayName: "Alchemy Adsense Probe",
            active: false,
          },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a custom channel",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const parent = yield* resolveParent();
      expect(parent).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Adsense.AdclientsCustomchannel("Homepage", {
            parent: parent!,
            displayName: "homepage",
            active: true,
          });
        }),
      );

      expect(created.name).toContain("/customchannels/");
      expect(created.parent).toEqual(parent);
      expect(created.customChannelId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("homepage");
      expect(created.active).toEqual(true);

      const fetched = yield* adsense.getAccountsAdclientsCustomchannels({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.active).toEqual(true);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Adsense.AdclientsCustomchannel("Homepage", {
            parent: created.parent,
            customChannelId: created.customChannelId,
            displayName: "homepage-v2",
            active: false,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("homepage-v2");
      expect(updated.active).toEqual(false);

      const fetchedUpdate = yield* adsense.getAccountsAdclientsCustomchannels({
        name: updated.name,
      });
      expect(fetchedUpdate.displayName).toContain("homepage-v2");
      expect(fetchedUpdate.active).toEqual(false);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(updated.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
