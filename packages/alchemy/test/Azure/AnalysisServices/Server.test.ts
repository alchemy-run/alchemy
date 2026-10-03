import * as Azure from "@/Azure";
import { resolveAzureCredentials } from "@/Azure/Credentials";
import * as Test from "@/Test/Alchemy";
import * as analysisservices from "@distilled.cloud/azure/analysisservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const getServer = (resourceGroupName: string, serverName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* analysisservices.GetServerDetails({
      subscriptionId,
      resourceGroupName,
      serverName,
    });
  });

const serverGone = (resourceGroupName: string, serverName: string) =>
  getServer(resourceGroupName, serverName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["NotFound", "ResourceNotFound", "ResourceGroupNotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );

const program = (props: {
  admin: string;
  tags: Record<string, string>;
  firewall: Azure.AnalysisServices.AnalysisServicesFirewall;
  paused?: boolean;
  location?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const server = yield* Azure.AnalysisServices.Server("Models", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      sku: "D1",
      administrators: [props.admin],
      firewall: props.firewall,
      paused: props.paused,
      tags: props.tags,
    });
    return { group, server };
  });

// D1 (Development) bills ~$0.13/h while running and $0 while paused; a run
// takes ~10 minutes, well under $0.10.
test.provider(
  "create, update, pause, replace, and delete an analysis services server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const creds = yield* yield* resolveAzureCredentials;
      const admin = `app:${creds.clientId}@${creds.tenantId}`;

      const { group, server } = yield* stack.deploy(
        program({
          admin,
          tags: { env: "test" },
          firewall: { enablePowerBIService: true, rules: [] },
        }),
      );
      expect(server.serverName).toMatch(/^[a-z][a-z0-9]{2,62}$/);
      expect(server.sku).toEqual("D1");
      expect(server.serverFullName).toContain(server.serverName);
      const observed = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(observed.properties?.state).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(
        observed.properties?.asAdministrators?.members?.map((m) =>
          m.toLowerCase(),
        ),
      ).toEqual([admin.toLowerCase()]);
      expect(
        observed.properties?.ipV4FirewallSettings?.enablePowerBIService,
      ).toEqual(true);

      // In place: tags, firewall rules, and suspend.
      const updated = yield* stack.deploy(
        program({
          admin,
          tags: { env: "prod" },
          firewall: {
            enablePowerBIService: false,
            rules: [
              {
                name: "office",
                rangeStart: "203.0.113.0",
                rangeEnd: "203.0.113.255",
              },
            ],
          },
          paused: true,
        }),
      );
      expect(updated.server.serverId).toEqual(server.serverId);
      expect(updated.server.state).toEqual("Paused");
      const reobserved = yield* getServer(
        group.resourceGroupName,
        server.serverName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.state).toEqual("Paused");
      const firewall = reobserved.properties?.ipV4FirewallSettings;
      expect(firewall?.enablePowerBIService).toEqual(false);
      expect(firewall?.firewallRules).toEqual([
        {
          firewallRuleName: "office",
          rangeStart: "203.0.113.0",
          rangeEnd: "203.0.113.255",
        },
      ]);

      // Replacement: a new location creates a new server and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          admin,
          tags: { env: "prod" },
          firewall: { enablePowerBIService: true, rules: [] },
          location: "westus",
        }),
      );
      expect(replaced.server.serverId).not.toEqual(server.serverId);
      expect(replaced.server.location.toLowerCase().replace(/\s/g, "")).toEqual(
        "westus",
      );
      expect(replaced.server.state).toEqual("Succeeded");
      expect(
        yield* serverGone(group.resourceGroupName, server.serverName),
      ).toEqual("gone");
      const moved = yield* getServer(
        group.resourceGroupName,
        replaced.server.serverName,
      );
      expect(moved.location.toLowerCase().replace(/\s/g, "")).toEqual("westus");
      expect(moved.properties?.serverFullName).toContain("westus");

      yield* stack.destroy();
      expect(
        yield* serverGone(
          replaced.group.resourceGroupName,
          replaced.server.serverName,
        ),
      ).toEqual("gone");
    }),
  {
    timeout: 900_000,
    tags: ["provider:azure", "provider:azure:analysisservices", "live"],
  },
);
