import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as datafactory from "@distilled.cloud/azure/datafactory";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getCredential = (
  resourceGroupName: string,
  factoryName: string,
  credentialName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* datafactory.GetCredentialOperation({
      subscriptionId,
      resourceGroupName,
      factoryName,
      credentialName,
    });
  });

const credentialGone = (
  resourceGroupName: string,
  factoryName: string,
  credentialName: string,
) =>
  getCredential(resourceGroupName, factoryName, credentialName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (props: { description: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("CredentialGroup", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "EtlIdentity",
      { resourceGroup: group.resourceGroupName },
    );
    const factory = yield* Azure.DataFactory.Factory("CredentialFactory", {
      resourceGroup: group.resourceGroupName,
      identity: {
        type: "SystemAssigned,UserAssigned",
        userAssignedIdentities: [identity.identityId],
      },
    });
    const credential = yield* Azure.DataFactory.Credential("EtlCredential", {
      resourceGroup: group.resourceGroupName,
      factoryName: factory.factoryName,
      resourceId: identity.identityId,
      description: props.description,
    });
    return { group, identity, factory, credential };
  });

// ~$0: identities and credentials are free. ~1-2 minutes.
test.provider(
  "create, update, and delete a managed identity credential",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, identity, factory, credential } = yield* stack.deploy(
        program({ description: "etl identity" }),
      );
      expect(credential.type).toEqual("ManagedIdentity");
      expect(factory.identityType).toEqual("SystemAssigned,UserAssigned");
      const observedFactory = yield* datafactory.GetFactory({
        subscriptionId: (yield* Azure.AzureEnvironment.current).subscriptionId,
        resourceGroupName: group.resourceGroupName,
        factoryName: factory.factoryName,
      });
      expect(
        Object.keys(observedFactory.identity?.userAssignedIdentities ?? {}).map(
          (id) => id.toLowerCase(),
        ),
      ).toEqual([identity.identityId.toLowerCase()]);
      const observed = yield* getCredential(
        group.resourceGroupName,
        factory.factoryName,
        credential.credentialName,
      );
      expect(observed.properties.description).toEqual("etl identity");
      expect(
        String(
          (observed.properties.typeProperties as { resourceId?: string })
            ?.resourceId,
        ).toLowerCase(),
      ).toEqual(identity.identityId.toLowerCase());

      // In place: description.
      const updated = yield* stack.deploy(
        program({ description: "etl identity v2" }),
      );
      expect(updated.credential.credentialName).toEqual(
        credential.credentialName,
      );
      const reobserved = yield* getCredential(
        group.resourceGroupName,
        factory.factoryName,
        credential.credentialName,
      );
      expect(reobserved.properties.description).toEqual("etl identity v2");

      yield* stack.destroy();
      expect(
        yield* credentialGone(
          group.resourceGroupName,
          factory.factoryName,
          credential.credentialName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:datafactory", "live"],
    timeout: 600_000,
  },
);
