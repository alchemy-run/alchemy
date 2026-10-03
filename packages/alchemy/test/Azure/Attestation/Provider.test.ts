import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as attestation from "@distilled.cloud/azure/attestation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getProvider = (resourceGroupName: string, providerName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* attestation.GetAttestationProvider({
      subscriptionId,
      resourceGroupName,
      providerName,
    });
  });

const providerGone = (resourceGroupName: string, providerName: string) =>
  getProvider(resourceGroupName, providerName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: {
  location: string;
  publicNetworkAccess: Azure.Attestation.AttestationToggle;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const provider = yield* Azure.Attestation.Provider("Attest", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      publicNetworkAccess: props.publicNetworkAccess,
      tags: props.tags,
    });
    return { group, provider };
  });

// The attestation provider itself is free and provisions in seconds.
test.provider(
  "create, update, replace, and delete an attestation provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, provider } = yield* stack.deploy(
        program({
          location: "eastus",
          publicNetworkAccess: "Enabled",
          tags: { env: "test" },
        }),
      );
      const rg = group.resourceGroupName;
      expect(provider.providerName).toMatch(/^[a-z0-9]{3,24}$/);
      expect(provider.attestUri).toContain(".attest.azure.net");
      expect(provider.trustModel).toEqual("AAD");
      const observed = yield* getProvider(rg, provider.providerName);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Attest");
      expect(observed.properties?.publicNetworkAccess).toEqual("Enabled");

      // In place: tags + public network access.
      const updated = yield* stack.deploy(
        program({
          location: "eastus",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(updated.provider.providerId).toEqual(provider.providerId);
      const reobserved = yield* getProvider(rg, provider.providerName);
      expect(reobserved.tags?.env).toEqual("prod");
      expect(reobserved.properties?.publicNetworkAccess).toEqual("Disabled");
      expect(updated.provider.publicNetworkAccess).toEqual("Disabled");

      // Replacement: location change.
      const replaced = yield* stack.deploy(
        program({
          location: "westus2",
          publicNetworkAccess: "Disabled",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.provider.providerName).not.toEqual(
        provider.providerName,
      );
      expect(replaced.provider.location).toEqual("westus2");
      expect(yield* providerGone(rg, provider.providerName)).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* providerGone(rg, replaced.provider.providerName),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:attestation", "live"],
    timeout: 900_000,
  },
);
