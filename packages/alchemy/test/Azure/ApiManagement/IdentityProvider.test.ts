import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import {
  basicV2Service,
  logLevel,
  subscriptionId,
  tags,
  untilGone,
} from "./fixture.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getProvider = (
  resourceGroupName: string,
  serviceName: string,
  identityProviderName: "aad" | "microsoft",
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetIdentityProvider({
      subscriptionId,
      resourceGroupName,
      serviceName,
      identityProviderName,
    }),
  );

/** Poll (bounded) until the allowed tenants match: reads lag behind writes. */
const untilTenants = (
  resourceGroupName: string,
  serviceName: string,
  expected: string[],
) =>
  getProvider(resourceGroupName, serviceName, "aad").pipe(
    Effect.map((provider) => provider.properties?.allowedTenants),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (tenants) => tenants?.join(",") === expected.join(","),
      times: 20,
    }),
  );

const program = (provider?: { type: "aad" | "microsoft"; tenant?: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const created = provider
      ? yield* Azure.ApiManagement.IdentityProvider("SignIn", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          type: provider.type,
          clientId: "00000000-0000-4000-8000-000000000071",
          clientSecret: Redacted.make("placeholder-secret"),
          allowedTenants: provider.tenant ? [provider.tenant] : undefined,
        })
      : undefined;
    return { group, service, provider: created };
  });

// Identity providers are not available on Consumption ("Method not
// allowed in Consumption pricing tier"). A BasicV2 service bills ~$0.21/h
// and takes 5-15+ minutes to create: est. ~$0.10 and ~25 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, replace, and delete an identity provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        program({ type: "aad", tenant: "contoso.onmicrosoft.com" }),
      );
      const rg = first.group.resourceGroupName;
      const svc = first.service.serviceName;
      expect(first.provider?.type).toEqual("aad");
      expect(
        yield* untilTenants(rg, svc, ["contoso.onmicrosoft.com"]),
      ).toEqual(["contoso.onmicrosoft.com"]);

      // In-place update of the allowed tenants.
      yield* stack.deploy(
        program({ type: "aad", tenant: "fabrikam.onmicrosoft.com" }),
      );
      expect(
        yield* untilTenants(rg, svc, ["fabrikam.onmicrosoft.com"]),
      ).toEqual(["fabrikam.onmicrosoft.com"]);

      // Replacement: another provider type creates a new identity provider.
      // (aadB2C is avoided: APIM validates that the B2C tenant and policies
      // exist, which needs a real B2C tenant.)
      yield* stack.deploy(program({ type: "microsoft" }));
      expect((yield* getProvider(rg, svc, "microsoft")).name).toEqual(
        "microsoft",
      );
      expect(yield* untilGone(getProvider(rg, svc, "aad"))).toEqual("gone");

      // Removing the resource deletes the identity provider.
      yield* stack.deploy(program());
      expect(yield* untilGone(getProvider(rg, svc, "microsoft"))).toEqual(
        "gone",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
