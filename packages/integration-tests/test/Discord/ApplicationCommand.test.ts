import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, expectGone, tags, testApplicationId, testGuildId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

// Names derive from the stage so concurrent users don't share a command.
const suffix = (stage: string) =>
  stage
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(-16);

test.provider(
  "guild slash command: create, update options, rename, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const guildId = yield* testGuildId;
      const applicationId = yield* testApplicationId;
      const get = (commandId: string) =>
        dc(
          discord.getGuildApplicationCommand({
            application_id: applicationId,
            guild_id: guildId,
            command_id: commandId,
          }),
        );
      const exists = (commandId: string) =>
        get(commandId).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        );
      const name = `roll-${suffix(stack.stage)}`;

      const v1 = yield* stack.deploy(
        Discord.ApplicationCommand("Roll", { guildId, name, description: "Roll dice" }),
      );
      expect(v1.guildId).toBe(guildId);
      expect(v1.mention).toBe(`</${name}:${v1.commandId}>`);

      const v2 = yield* stack.deploy(
        Discord.ApplicationCommand("Roll", {
          guildId,
          name,
          description: "Roll some dice",
          options: [
            { type: "integer", name: "sides", description: "Sides", minValue: 2, maxValue: 100 },
          ],
        }),
      );
      expect(v2.commandId).toBe(v1.commandId);
      const observed = yield* get(v1.commandId);
      expect(observed.description).toBe("Roll some dice");
      expect(observed.options?.map((o) => o.name)).toEqual(["sides"]);

      const v3 = yield* stack.deploy(
        Discord.ApplicationCommand("Roll", {
          guildId,
          name: `dice-${suffix(stack.stage)}`,
          description: "Roll some dice",
        }),
      );
      expect(v3.commandId).not.toBe(v1.commandId);
      yield* expectGone(exists(v1.commandId));

      yield* stack.destroy();
      yield* expectGone(exists(v3.commandId));
    }),
  { tags: tags("application-command"), timeout: 120_000 },
);

test.provider(
  "global message context-menu command",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const applicationId = yield* testApplicationId;
      const command = yield* stack.deploy(
        Discord.ApplicationCommand("Translate", {
          name: `Translate ${suffix(stack.stage)}`,
          type: "message",
        }),
      );
      expect(command.type).toBe("message");
      expect(command.guildId).toBeUndefined();
      yield* stack.destroy();
      yield* expectGone(
        dc(
          discord.getApplicationCommand({
            application_id: applicationId,
            command_id: command.commandId,
          }),
        ).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        ),
      );
    }),
  { tags: tags("application-command"), timeout: 120_000 },
);
