import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  consumptionService,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getServer = (
  resourceGroupName: string,
  serviceName: string,
  authsid: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetAuthorizationServer({
      subscriptionId,
      resourceGroupName,
      serviceName,
      authsid,
    }),
  );

const program = (server?: { name: string; scope: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = server
      ? yield* Azure.ApiManagement.AuthorizationServer("Entra", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: server.name,
          // Display names must be unique within the service.
          displayName: `Entra ${server.name}`,
          clientRegistrationEndpoint: "https://example.com/register",
          authorizationEndpoint:
            "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
          tokenEndpoint:
            "https://login.microsoftonline.com/common/oauth2/v2.0/token",
          grantTypes: ["authorizationCode"],
          clientId: "00000000-0000-4000-8000-000000000051",
          clientSecret: Redacted.make("placeholder-secret"),
          defaultScope: server.scope,
        })
      : undefined;
    return { group, service, server: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an authorization server",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-entra", scope: "openid" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.server?.authorizationServerName).toEqual("alchemy-entra");
      const observed = yield* getServer(rg, svc, "alchemy-entra");
      expect(observed.properties?.defaultScope).toEqual("openid");
      expect(observed.properties?.grantTypes).toEqual(["authorizationCode"]);

      // In-place update of the default scope.
      yield* stack.deploy(
        program({ name: "alchemy-entra", scope: "openid profile" }),
      );
      expect(
        (yield* getServer(rg, svc, "alchemy-entra")).properties?.defaultScope,
      ).toEqual("openid profile");

      // Replacement: a new identifier creates a new server.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-entra-v2", scope: "openid profile" }),
      );
      expect(replaced.server?.authorizationServerName).toEqual(
        "alchemy-entra-v2",
      );
      expect(yield* untilGone(getServer(rg, svc, "alchemy-entra"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the server.
      yield* stack.deploy(program());
      expect(yield* untilGone(getServer(rg, svc, "alchemy-entra-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
