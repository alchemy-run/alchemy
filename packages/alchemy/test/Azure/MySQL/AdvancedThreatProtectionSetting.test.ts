import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mysql from "@distilled.cloud/azure/mysql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, serverRef, tags, testServer, untilGone } from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (state: "Enabled" | "Disabled") =>
  Effect.gen(function* () {
    const { group, server } = yield* testServer();
    const protection = yield* Azure.MySQL.AdvancedThreatProtectionSetting(
      "Protection",
      {
        resourceGroup: group.resourceGroupName,
        server: server.serverName,
        state,
      },
    );
    return { group, server, protection };
  });

const getSettings = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* mysql.GetAdvancedThreatProtectionSettings({
      ...ref,
      advancedThreatProtectionName: "Default",
    });
  });

// One Burstable B1ms server (≈ $0.02/h) plus Defender for open-source
// databases (≈ $15/server/month, a few cents for this run), ~10 minutes.
test.provider(
  "enable, disable, and reset threat protection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server, protection } = yield* stack.deploy(
        program("Enabled"),
      );
      expect(protection.state).toEqual("Enabled");
      const observed = yield* getSettings(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.state).toEqual("Enabled");

      yield* stack.deploy(program("Disabled"));
      const disabled = yield* getSettings(
        group.resourceGroupName,
        server.serverName,
      );
      expect(disabled.properties?.state).toEqual("Disabled");

      yield* stack.deploy(program("Enabled"));
      // Removing the resource alone disables protection again.
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* testServer();
        }),
      );
      const reset = yield* getSettings(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reset.properties?.state).toEqual("Disabled");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          Effect.gen(function* () {
            const ref = yield* serverRef(
              group.resourceGroupName,
              server.serverName,
            );
            return yield* mysql.GetServer(ref);
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
