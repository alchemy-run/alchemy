import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as apim from "@distilled.cloud/azure/apimanagement";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  identityProviderName: "aad" | "aadB2C",
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    apim.GetIdentityProvider({
      subscriptionId,
      resourceGroupName,
      serviceName,
      identityProviderName,
    }),
  );

const program = (provider?: { type: "aad" | "aadB2C"; tenant: string }) =>
  Effect.gen(function* () {
    const { group, service } = yield* basicV2Service;
    const created = provider
      ? yield* Azure.ApiManagement.IdentityProvider("SignIn", {
          resourceGroup: group.resourceGroupName,
          serviceName: service.serviceName,
          type: provider.type,
          clientId: "00000000-0000-4000-8000-000000000071",
          clientSecret: Redacted.make("placeholder-secret"),
          allowedTenants: [provider.tenant],
          signinPolicyName:
            provider.type === "aadB2C" ? "B2C_1_signin" : undefined,
          signupPolicyName:
            provider.type === "aadB2C" ? "B2C_1_signup" : undefined,
          signinTenant:
            provider.type === "aadB2C" ? provider.tenant : undefined,
          authority:
            provider.type === "aadB2C" ? "fabrikam.b2clogin.com" : undefined,
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
        (yield* getProvider(rg, svc, "aad")).properties?.allowedTenants,
      ).toEqual(["contoso.onmicrosoft.com"]);

      // In-place update of the allowed tenants.
      yield* stack.deploy(
        program({ type: "aad", tenant: "fabrikam.onmicrosoft.com" }),
      );
      expect(
        (yield* getProvider(rg, svc, "aad")).properties?.allowedTenants,
      ).toEqual(["fabrikam.onmicrosoft.com"]);

      // Replacement: another provider type creates a new identity provider.
      yield* stack.deploy(
        program({ type: "aadB2C", tenant: "fabrikam.onmicrosoft.com" }),
      );
      expect((yield* getProvider(rg, svc, "aadB2C")).name).toEqual("aadB2C");
      expect(yield* untilGone(getProvider(rg, svc, "aad"))).toEqual("gone");

      // Removing the resource deletes the identity provider.
      yield* stack.deploy(program());
      expect(yield* untilGone(getProvider(rg, svc, "aadB2C"))).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
