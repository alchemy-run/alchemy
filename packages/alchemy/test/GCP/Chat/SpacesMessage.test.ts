import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as chat from "@distilled.cloud/gcp/chat_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasGcpCreds, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  chat.getSpacesMessages({ name }).pipe(
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
  "getSpacesMessages on a missing message fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chat.getSpacesMessages({
          name: "spaces/alchemy-missing/messages/client-missing",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.GCP_TEST_CHAT)(
  "createSpacesMessages without Chat access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        chat.createSpacesMessages({
          parent: "spaces/alchemy-missing",
          body: { text: "Alchemy Chat probe" },
        }),
      );
      expect(["Forbidden", "BadRequest", "NotFound"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a space message",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const space = yield* GCP.Chat.Space("MessageSpace", {
            displayName: "Messages",
            spaceType: "SPACE",
          });
          const message = yield* GCP.Chat.SpacesMessage("Hello", {
            parent: space.name,
            text: "hello from alchemy",
          });
          return { space, message };
        }),
      );

      expect(created.message.parent).toEqual(created.space.name);
      expect(created.message.name).toContain("/messages/");
      expect(created.message.text).toEqual("hello from alchemy");

      const fetched = yield* chat.getSpacesMessages({
        name: created.message.name,
      });
      expect(fetched.name).toEqual(created.message.name);
      expect(fetched.text).toContain("[alchemy ");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const space = yield* GCP.Chat.Space("MessageSpace", {
            spaceId: created.space.spaceId,
            displayName: "Messages",
            spaceType: "SPACE",
          });
          const message = yield* GCP.Chat.SpacesMessage("Hello", {
            parent: space.name,
            messageId: created.message.messageId,
            text: "updated hello",
          });
          return { space, message };
        }),
      );

      expect(updated.message.name).toEqual(created.message.name);
      expect(updated.message.text).toEqual("updated hello");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.message.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
