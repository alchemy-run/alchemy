import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { MP3_BEEP, mp3DataUri } from "./fixtures.ts";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "upload and update a soundboard sound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const exists = (soundId: string) =>
        dc(discord.getGuildSoundboardSound({ guild_id: guildId, sound_id: soundId })).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );

      const v1 = yield* stack.deploy(
        Discord.SoundboardSound("Beep", { guildId, sound: mp3DataUri(MP3_BEEP) }),
      );
      const v2 = yield* stack.deploy(
        Discord.SoundboardSound("Beep", {
          guildId,
          name: "alchemy-beep",
          sound: mp3DataUri(MP3_BEEP),
          volume: 0.5,
          emojiName: "🔔",
        }),
      );
      expect(v2.soundId).toBe(v1.soundId);
      const observed = yield* dc(
        discord.getGuildSoundboardSound({ guild_id: guildId, sound_id: v1.soundId }),
      );
      expect(observed.name).toBe("alchemy-beep");
      expect(observed.volume).toBe(0.5);
      expect(observed.emoji_name).toBe("🔔");

      yield* stack.destroy();
      yield* expectGone(exists(v1.soundId));
    }),
  { tags: tags("soundboard-sound"), timeout: 120_000 },
);
