import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as mysql from "@distilled.cloud/azure/mysql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, serverRef, tags, testServer, untilGone } from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const PARAMETER = "wait_timeout";

const program = (value: string) =>
  Effect.gen(function* () {
    const { group, server } = yield* testServer();
    const config = yield* Azure.MySQL.Configuration("WaitTimeout", {
      resourceGroup: group.resourceGroupName,
      server: server.serverName,
      name: PARAMETER,
      value,
    });
    return { group, server, config };
  });

const getConfiguration = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const ref = yield* serverRef(resourceGroupName, serverName);
    return yield* mysql.GetConfiguration({
      ...ref,
      configurationName: PARAMETER,
    });
  });

// One Burstable B1ms server (≈ $0.02/h) for ~10 minutes.
test.provider(
  "set, update, and reset a server parameter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, server, config } = yield* stack.deploy(program("600"));
      expect(config.value).toEqual("600");
      expect(config.isDynamicConfig).toEqual(true);
      const observed = yield* getConfiguration(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.value).toEqual("600");
      expect(observed.properties?.source).toEqual("user-override");

      const updated = yield* stack.deploy(program("1200"));
      expect(updated.config.value).toEqual("1200");
      const reobserved = yield* getConfiguration(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.properties?.value).toEqual("1200");

      // Deleting the configuration alone restores the default value.
      const { group: g2, server: s2 } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* testServer();
        }),
      );
      const reset = yield* getConfiguration(
        g2.resourceGroupName,
        s2.serverName,
      );
      expect(reset.properties?.value).toEqual(reset.properties?.defaultValue);
      expect(reset.properties?.value).not.toEqual("1200");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          Effect.gen(function* () {
            const ref = yield* serverRef(g2.resourceGroupName, s2.serverName);
            return yield* mysql.GetServer(ref);
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
