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

const TENANT = "00000000-0000-4000-8000-000000000041";

/** Read through the name-filtered list (the single GET is stale after writes). */
const findPolicy = (
  resourceGroupName: string,
  serviceName: string,
  name: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListAuthorizationAccessPolicyByAuthorization({
      subscriptionId,
      resourceGroupName,
      serviceName,
      authorizationProviderId: "alchemy-graph",
      authorizationId: "alchemy-conn",
      _filter: `name eq '${name}'`,
    }),
  ).pipe(Effect.map((page) => page.value?.find((p) => p.name === name)));

const untilGone = (
  resourceGroupName: string,
  serviceName: string,
  name: string,
) =>
  findPolicy(resourceGroupName, serviceName, name).pipe(
    Effect.map((found) => (found === undefined ? "gone" : "found")),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (policy?: { objectId: string; appIds: string[] }) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const provider = yield* Azure.ApiManagement.AuthorizationProvider("Graph", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      name: "alchemy-graph",
      displayName: "Graph",
      identityProvider: "aad",
      grantTypes: {
        clientCredentials: {
          resourceUri: "https://graph.microsoft.com",
          scopes: "https://graph.microsoft.com/.default",
          loginUri: "https://login.windows.net",
          tenantId: Redacted.make(TENANT),
        },
      },
    });
    const connection = yield* Azure.ApiManagement.Authorization("Connection", {
      resourceGroup: group.resourceGroupName,
      serviceName: service.serviceName,
      authorizationProviderName: provider.authorizationProviderName,
      name: "alchemy-conn",
      oauth2GrantType: "ClientCredentials",
      parameters: {
        clientId: Redacted.make("00000000-0000-4000-8000-000000000042"),
        clientSecret: Redacted.make("placeholder"),
      },
    });
    // The policy's tenant must be the service's own Entra tenant.
    const { tenantId } = yield* Azure.AzureEnvironment.current;
    const created = policy
      ? yield* Azure.ApiManagement.AuthorizationAccessPolicy("Access", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          authorizationProviderName: provider.authorizationProviderName,
          authorizationName: connection.authorizationName,
          name: "alchemy-access",
          tenantId,
          objectId: policy.objectId,
          appIds: policy.appIds,
        })
      : undefined;
    return { group, service, policy: created };
  });

const OBJECT_ONE = "00000000-0000-4000-8000-000000000043";
const OBJECT_TWO = "00000000-0000-4000-8000-000000000044";
const APP = "00000000-0000-4000-8000-000000000045";

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an authorization access policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ objectId: OBJECT_ONE, appIds: [] }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.policy?.objectId).toEqual(OBJECT_ONE);
      const observed = yield* findPolicy(rg, svc, "alchemy-access");
      expect(observed?.properties?.objectId).toEqual(OBJECT_ONE);

      // In-place update of the allowed client applications.
      yield* stack.deploy(program({ objectId: OBJECT_ONE, appIds: [APP] }));
      expect(
        (yield* findPolicy(rg, svc, "alchemy-access"))?.properties?.appIds,
      ).toEqual([APP]);

      // Replacement: a new object id deletes and re-creates the policy.
      const replaced = yield* stack.deploy(
        program({ objectId: OBJECT_TWO, appIds: [APP] }),
      );
      expect(replaced.policy?.objectId).toEqual(OBJECT_TWO);
      expect(
        (yield* findPolicy(rg, svc, "alchemy-access"))?.properties?.objectId,
      ).toEqual(OBJECT_TWO);

      // Removing the resource deletes the access policy.
      yield* stack.deploy(program());
      expect(yield* untilGone(rg, svc, "alchemy-access")).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
