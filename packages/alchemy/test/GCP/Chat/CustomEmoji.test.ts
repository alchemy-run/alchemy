import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as chat from "@distilled.cloud/gcp/chat_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  DEFAULT_EMOJI_PNG,
  hasGcpCreds,
  logLevel,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  chat.getCustomEmojis({ name }).pipe(
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
  "getCustomEmojis on a missing emoji fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chat.getCustomEmojis({
          name: "customEmojis/:alchemy-missing:",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CHAT)(
  "createCustomEmojis without Chat access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chat.createCustomEmojis({
          body: {
            emojiName: ":alch-probe:",
            payload: {
              filename: "alchemy.png",
              fileContent: DEFAULT_EMOJI_PNG,
            },
          },
        }),
      );
      expect(["Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create and delete a custom emoji",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Chat.CustomEmoji("Wave", {
            emojiName: ":alch-wave:",
            payload: {
              filename: "alchemy.png",
              fileContent: DEFAULT_EMOJI_PNG,
            },
          });
        }),
      );

      expect(created.name.startsWith("customEmojis/")).toEqual(true);
      expect(created.emojiName).toEqual(":alch-wave:");

      const fetched = yield* chat.getCustomEmojis({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.emojiName).toEqual(":alch-wave:");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
