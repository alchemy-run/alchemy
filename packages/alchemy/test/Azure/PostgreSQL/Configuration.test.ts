import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as postgresql from "@distilled.cloud/azure/postgresql";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, serverRef, tags, testServer, untilGone } from "./server.ts";

const { test } = Test.make({ providers: Azure.providers() });

const PARAMETER = "log_min_duration_statement";

const program = (value: string) =>
  Effect.gen(function* () {
    const { group, server } = yield* testServer();
    const config = yield* Azure.PostgreSQL.Configuration("SlowLog", {
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
    return yield* postgresql.GetConfiguration({
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

      const { group, server, config } = yield* stack.deploy(program("500"));
      expect(config.value).toEqual("500");
      expect(config.isDynamicConfig).toEqual(true);
      const observed = yield* getConfiguration(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.value).toEqual("500");
      expect(observed.properties?.source).toEqual("user-override");

      const updated = yield* stack.deploy(program("1000"));
      expect(updated.config.value).toEqual("1000");
      const reobserved = yield* getConfiguration(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.properties?.value).toEqual("1000");

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
      expect(reset.properties?.value).not.toEqual("1000");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          Effect.gen(function* () {
            const ref = yield* serverRef(g2.resourceGroupName, s2.serverName);
            return yield* postgresql.GetServer(ref);
          }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
