import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as chat from "@distilled.cloud/gcp/chat_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasGcpCreds, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  chat.getSpaces({ name }).pipe(
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
  "getSpaces on a missing space fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chat.getSpaces({ name: "spaces/alchemy-missing-space" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CHAT)(
  "createSpaces without Chat access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chat.createSpaces({
          body: {
            displayName: "Alchemy Chat Probe",
            spaceType: "SPACE",
          },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a space",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Chat.Space("Team", {
            displayName: "Platform",
            spaceType: "SPACE",
            spaceDetails: { description: "platform on-call" },
          });
        }),
      );

      expect(created.name.startsWith("spaces/")).toEqual(true);
      expect(created.spaceId.length).toBeGreaterThan(0);
      expect(created.displayName).toEqual("Platform");
      expect(created.spaceDetails?.description).toEqual("platform on-call");

      const fetched = yield* chat.getSpaces({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.displayName).toContain("[alchemy ");
      expect(fetched.spaceDetails?.guidelines).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Chat.Space("Team", {
            spaceId: created.spaceId,
            displayName: "Platform Eng",
            spaceType: "SPACE",
            spaceDetails: { description: "platform engineering" },
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.displayName).toEqual("Platform Eng");
      expect(updated.spaceDetails?.description).toEqual("platform engineering");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
