import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const GRAPH = "https://graph.microsoft.com";
const VAULT = "https://vault.azure.net";

/**
 * Read the provider out of band through the list: the single-entity GET
 * serves a stale copy for minutes after writes.
 */
const findProvider = (
  resourceGroupName: string,
  serviceName: string,
  name: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListAuthorizationProviderByService({
      subscriptionId,
      resourceGroupName,
      serviceName,
    }),
  ).pipe(Effect.map((page) => page.value?.find((p) => p.name === name)));

const getProvider = (
  resourceGroupName: string,
  serviceName: string,
  name: string,
) =>
  findProvider(resourceGroupName, serviceName, name).pipe(
    Effect.flatMap((provider) =>
      provider === undefined
        ? Effect.die(new Error(`authorization provider ${name} not found`))
        : Effect.succeed(provider),
    ),
  );

/** Poll until the provider is no longer listed (bounded). */
const untilGone = (
  resourceGroupName: string,
  serviceName: string,
  name: string,
) =>
  findProvider(resourceGroupName, serviceName, name).pipe(
    Effect.map((provider) => (provider === undefined ? "gone" : "found")),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

/**
 * APIM does not contact the identity provider until an authorization is
 * created, so a placeholder tenant is enough for the provider.
 */
const program = (provider?: {
  name: string;
  displayName: string;
  resourceUri: string;
}) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = provider
      ? yield* Azure.ApiManagement.AuthorizationProvider("Entra", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: provider.name,
          displayName: provider.displayName,
          identityProvider: "aad",
          grantTypes: {
            clientCredentials: {
              resourceUri: provider.resourceUri,
              scopes: `${provider.resourceUri}/.default`,
              loginUri: "https://login.windows.net",
              tenantId: Redacted.make("00000000-0000-4000-8000-000000000022"),
            },
          },
        })
      : undefined;
    return { group, service, provider: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an authorization provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({
          name: "alchemy-entra",
          displayName: "Entra",
          resourceUri: GRAPH,
        }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.provider?.authorizationProviderName).toEqual(
        "alchemy-entra",
      );
      const observed = yield* getProvider(rg, svc, "alchemy-entra");
      expect(observed.properties?.displayName).toEqual("Entra");
      expect(observed.properties?.identityProvider).toEqual("aad");
      expect(
        observed.properties?.oauth2?.grantTypes?.clientCredentials?.resourceUri,
      ).toEqual(GRAPH);

      // In-place update: display name and grant parameters.
      yield* stack.deploy(
        program({
          name: "alchemy-entra",
          displayName: "Entra ID",
          resourceUri: VAULT,
        }),
      );
      const updated = yield* getProvider(rg, svc, "alchemy-entra");
      expect(updated.properties?.displayName).toEqual("Entra ID");
      expect(
        updated.properties?.oauth2?.grantTypes?.clientCredentials?.resourceUri,
      ).toEqual(VAULT);

      // Replacement: a new identifier creates a new provider and deletes the old.
      const replaced = yield* stack.deploy(
        program({
          name: "alchemy-entra-v2",
          displayName: "Entra ID",
          resourceUri: VAULT,
        }),
      );
      expect(replaced.provider?.authorizationProviderName).toEqual(
        "alchemy-entra-v2",
      );
      expect(
        (yield* getProvider(rg, svc, "alchemy-entra-v2")).properties
          ?.identityProvider,
      ).toEqual("aad");
      expect(yield* untilGone(rg, svc, "alchemy-entra")).toEqual("gone");

      // Removing the resource deletes the provider.
      yield* stack.deploy(program());
      expect(yield* untilGone(rg, svc, "alchemy-entra-v2")).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
