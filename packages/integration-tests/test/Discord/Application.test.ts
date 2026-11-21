import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "set the application's description and tags, restore on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const app = dc(discord.getMyApplication({}));
      const before = yield* app;

      const out = yield* stack.deploy(
        Discord.Application("App", {
          description: `alchemy ${stack.stage}`,
          tags: ["alchemy", "test"],
        }),
      );
      expect(out.applicationId).toBe(before.id);
      expect(out.publicKey).toMatch(/^[0-9a-f]{64}$/);
      const during = yield* app;
      expect(during.description).toBe(`alchemy ${stack.stage}`);
      expect(during.tags).toEqual(["alchemy", "test"]);

      yield* stack.destroy();
      const after = yield* app;
      expect(after.description).toBe(before.description);
      expect(after.tags ?? []).toEqual(before.tags ?? []);
    }),
  { tags: tags("application"), timeout: 120_000, exclusive: "discord:application" },
);
