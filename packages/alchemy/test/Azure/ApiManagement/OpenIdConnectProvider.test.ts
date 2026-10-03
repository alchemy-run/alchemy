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

const getProvider = (
  resourceGroupName: string,
  serviceName: string,
  opid: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetOpenIdConnectProvider({
      subscriptionId,
      resourceGroupName,
      serviceName,
      opid,
    }),
  );

const program = (provider?: { name: string; description: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* consumptionService;
    const created = provider
      ? yield* Azure.ApiManagement.OpenIdConnectProvider("Entra", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          name: provider.name,
          displayName: `Entra ${provider.name}`,
          description: provider.description,
          metadataEndpoint:
            "https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
          clientId: "00000000-0000-4000-8000-000000000061",
          clientSecret: Redacted.make("placeholder-secret"),
        })
      : undefined;
    return { group, service, provider: created };
  });

// One Consumption service (no idle cost, ~3 min create, ~5 min delete).
test.provider(
  "create, update, replace, and delete an OpenID Connect provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ name: "alchemy-oidc", description: "first" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.provider?.openIdConnectProviderName).toEqual("alchemy-oidc");
      expect(
        (yield* getProvider(rg, svc, "alchemy-oidc")).properties?.description,
      ).toEqual("first");

      // In-place update of the description.
      yield* stack.deploy(
        program({ name: "alchemy-oidc", description: "second" }),
      );
      expect(
        (yield* getProvider(rg, svc, "alchemy-oidc")).properties?.description,
      ).toEqual("second");

      // Replacement: a new identifier creates a new provider.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-oidc-v2", description: "second" }),
      );
      expect(replaced.provider?.openIdConnectProviderName).toEqual(
        "alchemy-oidc-v2",
      );
      expect(yield* untilGone(getProvider(rg, svc, "alchemy-oidc"))).toEqual(
        "gone",
      );

      // Removing the resource deletes the provider.
      yield* stack.deploy(program());
      expect(yield* untilGone(getProvider(rg, svc, "alchemy-oidc-v2"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
