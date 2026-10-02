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

/** Read through the name-filtered list (the single GET is stale after writes). */
const findAuthorization = (
  resourceGroupName: string,
  serviceName: string,
  name: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.ListAuthorizationByAuthorizationProvider({
      subscriptionId,
      resourceGroupName,
      serviceName,
      authorizationProviderId: "alchemy-graph",
      _filter: `name eq '${name}'`,
    }),
  ).pipe(Effect.map((page) => page.value?.find((a) => a.name === name)));

const untilGone = (
  resourceGroupName: string,
  serviceName: string,
  name: string,
) =>
  findAuthorization(resourceGroupName, serviceName, name).pipe(
    Effect.map((found) => (found === undefined ? "gone" : "found")),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const credentialProvider = Effect.gen(function* () {
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
        tenantId: Redacted.make("00000000-0000-4000-8000-000000000031"),
      },
    },
  });
  return { group, service, provider };
});

const program = (authorization?: { name: string; secret: string }) =>
  Effect.gen(function* () {
    const { group, service, provider } = yield* credentialProvider;
    // Placeholder client credentials: APIM stores the connection and
    // reports a token-acquisition error in its status.
    const created = authorization
      ? yield* Azure.ApiManagement.Authorization("Connection", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          authorizationProviderName: provider.authorizationProviderName,
          name: authorization.name,
          oauth2GrantType: "ClientCredentials",
          parameters: {
            clientId: Redacted.make("00000000-0000-4000-8000-000000000032"),
            clientSecret: Redacted.make(authorization.secret),
          },
        })
      : undefined;
    return { group, service, provider, authorization: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an authorization",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-conn", secret: "secret-one" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.authorization?.authorizationName).toEqual("alchemy-conn");
      expect(first.authorization?.oauth2GrantType).toEqual("ClientCredentials");
      const observed = yield* findAuthorization(rg, svc, "alchemy-conn");
      expect(observed?.properties?.oauth2grantType).toEqual(
        "ClientCredentials",
      );

      // In-place update: rotating the client secret re-sends the parameters.
      const rotated = yield* stack.deploy(
        program({ name: "alchemy-conn", secret: "secret-two" }),
      );
      expect(rotated.authorization?.authorizationId).toEqual(
        first.authorization?.authorizationId,
      );

      // Replacement: a new identifier creates a new connection.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-conn-v2", secret: "secret-two" }),
      );
      expect(replaced.authorization?.authorizationName).toEqual(
        "alchemy-conn-v2",
      );
      expect(yield* untilGone(rg, svc, "alchemy-conn")).toEqual("gone");

      // Removing the resource deletes the connection.
      yield* stack.deploy(program());
      expect(yield* untilGone(rg, svc, "alchemy-conn-v2")).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
