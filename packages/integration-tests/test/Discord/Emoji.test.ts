import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { PNG_32, PNG_320, pngDataUri } from "./fixtures.ts";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

const emojiExists = (guildId: string, emojiId: string) =>
  dc(discord.getGuildEmoji({ guild_id: guildId, emoji_id: emojiId })).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "upload, rename and replace an emoji",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;

      const v1 = yield* stack.deploy(
        Discord.Emoji("Party", { guildId, image: pngDataUri(PNG_32) }),
      );
      expect(v1.name).toMatch(/^[A-Za-z0-9_]{2,32}$/);
      expect(v1.mention).toBe(`<:${v1.name}:${v1.emojiId}>`);

      const v2 = yield* stack.deploy(
        Discord.Emoji("Party", { guildId, name: "alchemy_party", image: pngDataUri(PNG_32) }),
      );
      expect(v2.emojiId).toBe(v1.emojiId);
      expect(
        (yield* dc(discord.getGuildEmoji({ guild_id: guildId, emoji_id: v1.emojiId }))).name,
      ).toBe("alchemy_party");

      // A new image is a new emoji.
      const v3 = yield* stack.deploy(
        Discord.Emoji("Party", { guildId, name: "alchemy_party", image: pngDataUri(PNG_320) }),
      );
      expect(v3.emojiId).not.toBe(v1.emojiId);
      yield* expectGone(emojiExists(guildId, v1.emojiId));

      yield* stack.destroy();
      yield* expectGone(emojiExists(guildId, v3.emojiId));
    }),
  { tags: tags("emoji"), timeout: 120_000 },
);
