import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm.ts";
import * as Test from "@/Test/Alchemy";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const tags = ["provider:azure", "provider:azure:authorization", "live"];

const getAssociation = (groupId: string, plaId: string) =>
  orUndefinedIfNotFound(
    resources.GetPrivateLinkAssociation({ groupId, plaId }),
  );

// The trial's service principal has no rights on the tenant root management
// group, so the association API rejects every call with AuthorizationFailed.
test.provider(
  "probe: private link associations need management-group write access",
  (_stack) =>
    Effect.gen(function* () {
      const { tenantId, subscriptionId } =
        yield* Azure.AzureEnvironment.current;
      const result = yield* resources
        .PutPrivateLinkAssociation({
          groupId: tenantId,
          plaId: "5d7d3c5c-1d1e-4a52-9a1b-0d6a1e7d2f11",
          properties: {
            privateLink: `/subscriptions/${subscriptionId}/resourceGroups/alchemy-probe/providers/Microsoft.Authorization/resourceManagementPrivateLinks/probe`,
            publicNetworkAccess: "Enabled",
          },
        })
        .pipe(Effect.flip);
      expect(result._tag).toEqual("AuthorizationFailed");
    }),
  { tags, timeout: 120_000 },
);

const program = (linkId: "LinkA" | "LinkB") =>
  Effect.gen(function* () {
    const { tenantId } = yield* Azure.AzureEnvironment.current;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both links stay deployed across the replacement step (engine
    // deadlock when a replaced resource's old dependency is removed).
    const linkA = yield* Azure.Resources.ResourceManagementPrivateLink(
      "LinkA",
      { resourceGroup: group.resourceGroupName },
    );
    const linkB = yield* Azure.Resources.ResourceManagementPrivateLink(
      "LinkB",
      { resourceGroup: group.resourceGroupName },
    );
    const link = linkId === "LinkA" ? linkA : linkB;
    const association = yield* Azure.Authorization.PrivateLinkAssociation(
      "Association",
      {
        managementGroupId: tenantId,
        privateLink: link.resourceManagementPrivateLinkId,
        // Never "Disabled" here: it would cut the test principal's public
        // ARM access for the whole tenant.
        publicNetworkAccess: "Enabled",
      },
    );
    return { link, association };
  });

// Free, < 1 min, but needs Owner on the tenant root management group and
// affects management traffic for the whole tenant: run only with
// AZURE_TEST_PAID=1 on a dedicated tenant. The only mutable setting
// (publicNetworkAccess) cannot be flipped safely, so the lifecycle covers
// create, replacement (new private link) and delete.
test.provider.skipIf(!runPaidOnly)(
  "associate a private link with the tenant root group, replace it, and delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { link, association } = yield* stack.deploy(program("LinkA"));
      expect(association.privateLink.toLowerCase()).toEqual(
        link.resourceManagementPrivateLinkId.toLowerCase(),
      );
      expect(association.publicNetworkAccess).toEqual("Enabled");
      const observed = yield* getAssociation(
        association.managementGroupId,
        association.privateLinkAssociationName,
      );
      expect(observed?.properties?.privateLink?.toLowerCase()).toEqual(
        link.resourceManagementPrivateLinkId.toLowerCase(),
      );

      // A different private link replaces the association.
      const replaced = yield* stack.deploy(program("LinkB"));
      expect(replaced.association.privateLinkAssociationName).not.toEqual(
        association.privateLinkAssociationName,
      );
      expect(replaced.association.privateLink.toLowerCase()).toEqual(
        replaced.link.resourceManagementPrivateLinkId.toLowerCase(),
      );

      yield* stack.destroy();
      for (const name of [
        association.privateLinkAssociationName,
        replaced.association.privateLinkAssociationName,
      ]) {
        const gone = yield* getAssociation(
          association.managementGroupId,
          name,
        ).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("3 seconds"),
            until: (value) => value === undefined,
            times: 20,
          }),
        );
        expect(gone).toBeUndefined();
      }
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
