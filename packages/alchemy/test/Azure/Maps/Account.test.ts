import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as maps from "@distilled.cloud/azure/maps";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getAccount = (resourceGroupName: string, accountName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* maps.GetAccount({
      subscriptionId,
      resourceGroupName,
      accountName,
    });
  });

const accountGone = (resourceGroupName: string, accountName: string) =>
  getAccount(resourceGroupName, accountName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  location: string;
  tags: Record<string, string>;
  cors?: Azure.Maps.MapsCorsRule[];
  disableLocalAuth?: boolean;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const account = yield* Azure.Maps.Account("Maps", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      tags: props.tags,
      cors: props.cors,
      disableLocalAuth: props.disableLocalAuth,
    });
    return { group, account };
  });

// Gen2 Maps accounts have no hourly fee (per-transaction billing, free
// monthly allowance) and provision in seconds.
test.provider(
  "create, update, replace, and delete a maps account",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      expect(account.accountName).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,97}$/);
      expect(account.sku).toEqual("G2");
      expect(account.kind).toEqual("Gen2");
      expect(account.uniqueId).not.toEqual("");
      expect(account.disableLocalAuth).toEqual(false);
      expect(account.primaryKey).toBeDefined();
      expect(Redacted.value(account.primaryKey!).length).toBeGreaterThan(10);

      const observed = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(observed.location.toLowerCase()).toEqual("eastus");
      expect(observed.sku.name).toEqual("G2");
      expect(observed.kind).toEqual("Gen2");
      expect(observed.properties?.uniqueId).toEqual(account.uniqueId);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Maps");

      // In-place update: tags, CORS, and local auth.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          tags: { env: "prod" },
          cors: [{ allowedOrigins: ["https://example.com"] }],
          disableLocalAuth: true,
        }),
      );
      expect(updated.account.accountName).toEqual(account.accountName);
      expect(updated.account.uniqueId).toEqual(account.uniqueId);
      expect(updated.account.disableLocalAuth).toEqual(true);
      expect(updated.account.primaryKey).toBeUndefined();
      const reobserved = yield* getAccount(
        group.resourceGroupName,
        account.accountName,
      );
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.disableLocalAuth).toEqual(true);
      expect(
        reobserved.properties?.cors?.corsRules?.map((r) => r.allowedOrigins),
      ).toEqual([["https://example.com"]]);

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          tags: { env: "prod" },
          cors: [{ allowedOrigins: ["https://example.com"] }],
          disableLocalAuth: true,
        }),
      );
      expect(replaced.account.location.toLowerCase()).toEqual("westus2");
      expect(replaced.account.uniqueId).not.toEqual(account.uniqueId);
      const replacedObserved = yield* getAccount(
        group.resourceGroupName,
        replaced.account.accountName,
      );
      expect(replacedObserved.location.toLowerCase()).toEqual("westus2");
      if (
        replaced.account.accountName.toLowerCase() !==
        account.accountName.toLowerCase()
      ) {
        expect(
          yield* accountGone(group.resourceGroupName, account.accountName),
        ).toEqual("gone");
      }

      yield* stack.destroy();
      expect(
        yield* accountGone(
          group.resourceGroupName,
          replaced.account.accountName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:maps", "live"],
    timeout: 600_000,
  },
);
