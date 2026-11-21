import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { PNG_32, pngDataUri } from "./fixtures.ts";
import { dc, expectGone, tags, testApplicationId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "upload and rename an application emoji",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const applicationId = yield* testApplicationId;
      const exists = (emojiId: string) =>
        dc(discord.getApplicationEmoji({ application_id: applicationId, emoji_id: emojiId })).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );

      const v1 = yield* stack.deploy(Discord.ApplicationEmoji("Ok", { image: pngDataUri(PNG_32) }));
      expect(v1.applicationId).toBe(applicationId);

      const v2 = yield* stack.deploy(
        Discord.ApplicationEmoji("Ok", { name: "alchemy_status_ok", image: pngDataUri(PNG_32) }),
      );
      expect(v2.emojiId).toBe(v1.emojiId);
      expect(v2.name).toBe("alchemy_status_ok");

      yield* stack.destroy();
      yield* expectGone(exists(v1.emojiId));
    }),
  { tags: tags("application-emoji"), timeout: 120_000 },
);
