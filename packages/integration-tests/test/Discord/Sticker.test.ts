import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { PNG_320 } from "./fixtures.ts";
import { dc, expectGone, tags, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "upload and update a sticker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const exists = (stickerId: string) =>
        dc(discord.getGuildSticker({ guild_id: guildId, sticker_id: stickerId })).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );

      const v1 = yield* stack.deploy(
        Discord.Sticker("Wave", { guildId, name: "alchemy-wave", tags: "wave", file: PNG_320 }),
      );
      const v2 = yield* stack.deploy(
        Discord.Sticker("Wave", {
          guildId,
          name: "alchemy-wave",
          tags: "smile",
          description: "Hello from alchemy",
          file: PNG_320,
        }),
      );
      expect(v2.stickerId).toBe(v1.stickerId);
      const observed = yield* dc(
        discord.getGuildSticker({ guild_id: guildId, sticker_id: v1.stickerId }),
      );
      expect(observed.tags).toBe("smile");
      expect(observed.description).toBe("Hello from alchemy");

      yield* stack.destroy();
      yield* expectGone(exists(v1.stickerId));
    }),
  { tags: tags("sticker"), timeout: 120_000 },
);
