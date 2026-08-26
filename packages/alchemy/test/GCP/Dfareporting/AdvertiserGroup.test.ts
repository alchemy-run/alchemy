import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  logLevel,
  resolveProfileId,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (profileId: string, id: string) =>
  dfa.getAdvertiserGroups({ profileId, id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getAdvertiserGroups on a missing group fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.getAdvertiserGroups({ profileId: "1", id: "1" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DFAREPORTING)(
  "insertAdvertiserGroups without Campaign Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.insertAdvertiserGroups({
          profileId: "1",
          body: { name: "alchemy-dfareporting-probe" },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete an advertiser group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const profileId = yield* resolveProfileId();
      expect(profileId).toEqual(expect.any(String));

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.AdvertiserGroup("Brands", {
            profileId: profileId!,
            name: "alchemy-brands",
          });
        }),
      );

      expect(created.id).toEqual(expect.any(String));
      expect(created.profileId).toEqual(profileId);
      expect(created.name).toEqual("alchemy-brands");

      const fetched = yield* dfa.getAdvertiserGroups({
        profileId: created.profileId,
        id: created.id,
      });
      expect(fetched.id).toEqual(created.id);
      expect(fetched.name).toContain("alchemy-id=");
      expect(fetched.name).toContain("alchemy-brands");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Dfareporting.AdvertiserGroup("Brands", {
            profileId: created.profileId,
            id: created.id,
            name: "alchemy-brands-v2",
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.name).toEqual("alchemy-brands-v2");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.profileId, created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
