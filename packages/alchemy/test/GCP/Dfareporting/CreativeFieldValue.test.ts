import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  advertiserIdFromEnv,
  hasGcpCreds,
  logLevel,
  resolveProfileId,
  runAdvertiserLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (
  profileId: string,
  creativeFieldId: string,
  id: string,
) =>
  dfa.getCreativeFieldValues({ profileId, creativeFieldId, id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getCreativeFieldValues on a missing value fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.getCreativeFieldValues({
          profileId: "1",
          creativeFieldId: "1",
          id: "1",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_DFAREPORTING)(
  "insertCreativeFieldValues without Campaign Manager access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        dfa.insertCreativeFieldValues({
          profileId: "1",
          creativeFieldId: "1",
          body: { value: "alchemy-dfareporting-probe" },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runAdvertiserLifecycle)(
  "create, update, and delete a creative field value",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const profileId = yield* resolveProfileId();
      expect(profileId).toEqual(expect.any(String));
      const advertiserId = advertiserIdFromEnv!;

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const field = yield* GCP.Dfareporting.CreativeField("Color", {
            profileId: profileId!,
            advertiserId,
            name: "alchemy-color",
          });
          const value = yield* GCP.Dfareporting.CreativeFieldValue("Red", {
            profileId: field.profileId,
            creativeFieldId: field.id,
            value: "red",
          });
          return { field, value };
        }),
      );

      expect(created.value.id).toEqual(expect.any(String));
      expect(created.value.creativeFieldId).toEqual(created.field.id);
      expect(created.value.value).toEqual("red");

      const fetched = yield* dfa.getCreativeFieldValues({
        profileId: created.value.profileId,
        creativeFieldId: created.value.creativeFieldId,
        id: created.value.id,
      });
      expect(fetched.id).toEqual(created.value.id);
      expect(fetched.value).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const field = yield* GCP.Dfareporting.CreativeField("Color", {
            profileId: created.field.profileId,
            advertiserId: created.field.advertiserId,
            id: created.field.id,
            name: "alchemy-color",
          });
          const value = yield* GCP.Dfareporting.CreativeFieldValue("Red", {
            profileId: created.value.profileId,
            creativeFieldId: field.id,
            id: created.value.id,
            value: "crimson",
          });
          return { field, value };
        }),
      );

      expect(updated.value.id).toEqual(created.value.id);
      expect(updated.value.value).toEqual("crimson");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(
        created.value.profileId,
        created.value.creativeFieldId,
        created.value.id,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
