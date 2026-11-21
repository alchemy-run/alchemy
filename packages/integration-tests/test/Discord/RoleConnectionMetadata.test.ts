import * as Discord from "@alchemy.run/discord";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as discord from "@distilled.cloud/discord/discord";
import * as Effect from "effect/Effect";
import { dc, tags, testApplicationId } from "./helpers.ts";

const { test } = Test.make({ providers: Discord.providers() });

test.provider(
  "set, update and clear linked-roles metadata",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const applicationId = yield* testApplicationId;
      const records = dc(
        discord.getApplicationRoleConnectionsMetadata({ application_id: applicationId }),
      ).pipe(Effect.map((r) => r ?? []));

      yield* stack.deploy(
        Discord.RoleConnectionMetadata("LinkedRoles", {
          records: [
            {
              key: "level",
              name: "Level",
              description: "Minimum level",
              type: "integerGreaterThanOrEqual",
            },
          ],
        }),
      );
      expect((yield* records).map((r) => r.key)).toEqual(["level"]);

      yield* stack.deploy(
        Discord.RoleConnectionMetadata("LinkedRoles", {
          records: [
            {
              key: "level",
              name: "Level",
              description: "Minimum level",
              type: "integerGreaterThanOrEqual",
            },
            {
              key: "verified",
              name: "Verified",
              description: "Verified account",
              type: "booleanEqual",
            },
          ],
        }),
      );
      expect((yield* records).map((r) => r.key)).toEqual(["level", "verified"]);

      yield* stack.destroy();
      expect(yield* records).toEqual([]);
    }),
  { tags: tags("role-connection-metadata"), timeout: 120_000, exclusive: "discord:application" },
);
