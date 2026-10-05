import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import type { Input } from "@/Input";
import { ensureFeature } from "../features.ts";
import { runExpensive } from "../gates.ts";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  subscription,
  tags,
  template,
  uploadTemplate,
  uploadVhd,
  vhd,
  waitGone,
  withStore,
  withVhdStore,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

// Managed Identity Operator (not in `BuiltInRole`).
const MANAGED_IDENTITY_OPERATOR = "f1a07417-d97a-45cb-824c-7a7467783830";

/**
 * The store plus the NFVI resource group and the user-assigned identity AOSM
 * deploys with: Contributor on the NFVI and publisher groups, Managed
 * Identity Operator on itself. Deployed before the function so the grants
 * exist (and propagate) before AOSM runs the deployment.
 */
const withIdentity = Effect.gen(function* () {
  const { group, publisher, store, manifest } = yield* withStore;
  const { vhdStore, vhdManifest } = yield* withVhdStore({
    resourceGroup: group.resourceGroupName,
    publisher: publisher.publisherName,
  });
  // The NFVI: an Azure Core resource group the function deploys into.
  const target = yield* Azure.Resources.ResourceGroup("Target", { location });
  const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
    "Identity",
    { resourceGroup: group.resourceGroupName, location },
  );
  const grant = (id: string, scope: Input<string>, roleDefinitionId: string) =>
    Azure.Authorization.RoleAssignment(id, {
      scope,
      roleDefinitionId,
      principalId: identity.principalId,
      principalType: "ServicePrincipal",
    });
  yield* grant(
    "TargetContributor",
    target.resourceGroupId,
    Azure.Authorization.BuiltInRole.Contributor,
  );
  yield* grant(
    "GroupContributor",
    group.resourceGroupId,
    Azure.Authorization.BuiltInRole.Contributor,
  );
  yield* grant(
    "IdentityOperator",
    identity.identityId,
    MANAGED_IDENTITY_OPERATOR,
  );
  return {
    group,
    publisher,
    store,
    manifest,
    vhdStore,
    vhdManifest,
    target,
    identity,
  };
});

const program = (props: { region: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const { group, publisher, store, vhdStore, manifest, target, identity } =
      yield* withIdentity;
    const nfdg = yield* Azure.HybridNetwork.NetworkFunctionDefinitionGroup(
      "Nfdg",
      {
        resourceGroup: group.resourceGroupName,
        publisher: publisher.publisherName,
        location,
      },
    );
    const nfdv = yield* Azure.HybridNetwork.NetworkFunctionDefinitionVersion(
      "Nfdv",
      {
        resourceGroup: group.resourceGroupName,
        publisher: publisher.publisherName,
        networkFunctionDefinitionGroup: nfdg.networkFunctionDefinitionGroupName,
        location,
        version: "1.0.0",
        networkFunctionType: "VirtualNetworkFunction",
        deployParameters: JSON.stringify({
          type: "object",
          properties: { region: { type: "string" } },
        }),
        networkFunctionTemplate: {
          nfviType: "AzureCore",
          // An Azure Core VNF needs a VHD image and an ARM template.
          networkFunctionApplications: [
            {
              artifactType: "VhdImageFile",
              name: "image",
              artifactProfile: {
                artifactStore: { id: vhdStore.artifactStoreId },
                vhdArtifactProfile: {
                  vhdName: vhd.name,
                  vhdVersion: vhd.version,
                },
              },
              deployParametersMappingRuleProfile: {
                applicationEnablement: "Enabled",
                vhdImageMappingRuleProfile: {
                  userConfiguration: JSON.stringify({
                    imageName: "nfimage",
                    azureDeployLocation: location,
                  }),
                },
              },
            },
            {
              artifactType: "ArmTemplate",
              name: "app",
              artifactProfile: {
                artifactStore: { id: store.artifactStoreId },
                templateArtifactProfile: {
                  templateName: template.name,
                  templateVersion: template.version,
                },
              },
              deployParametersMappingRuleProfile: {
                applicationEnablement: "Unknown",
                templateMappingRuleProfile: { templateParameters: "{}" },
              },
            },
          ],
        },
        // `az aosm` publishes definitions as Preview; activating one with a
        // VHD application never leaves 'Updating' on this subscription.
        versionState: "Preview",
      },
    );
    const nf = yield* Azure.HybridNetwork.NetworkFunction("Function", {
      resourceGroup: group.resourceGroupName,
      location,
      networkFunctionDefinitionVersionId:
        nfdv.networkFunctionDefinitionVersionId,
      nfviType: "AzureCore",
      nfviId: target.resourceGroupId,
      deploymentValues: JSON.stringify({ region: props.region }),
      allowSoftwareUpdate: true,
      identity: {
        type: "UserAssigned",
        userAssignedIdentities: [identity.identityId],
      },
      tags: props.tags,
    });
    return { group, publisher, store, manifest, nf };
  });

// Standard ACR and storage-account artifact stores plus an AOSM deployment
// of an empty VHD image and an empty ARM template onto an Azure Core
// resource group: a few cents per run, ~25 minutes (two AOSM deployments).
// AOSM deploys with the user-assigned identity, which needs Contributor on
// the NFVI and publisher groups.
// As of 2026-10 AOSM never starts the deployment on this subscription: after
// ~9 minutes the PUT's async operation ends 'Failed' with
// `InternalServerError`, and nothing is deployed into the NFVI group. AOSM
// requires Microsoft to allow-list the subscription (account team / partner
// registration form); the approval-gated `Microsoft.HybridNetwork` features
// `Allow-2023-09-01` and `HybridNetworkRPaaSRegistration` stay `Pending`.
// Skipped: failed in the last live run. Azure.ProvisioningFailed: AOSM network function
// Azure-HybridNetwork-NetworkFunction-creaiopqquegfplpnnxd4jihfz7t provisioning ended in state
// 'Failed'
test.provider.skip(
  "create, update, and delete a network function",
  (stack) =>
    Effect.gen(function* () {
      yield* ensureFeature("Microsoft.HybridNetwork", "allowVnfVendor");
      yield* ensureFeature("Microsoft.HybridNetwork", "allowVnfCustomer");
      yield* ensureFeature("Microsoft.HybridNetwork", "MsiForResourceEnabled");
      yield* stack.destroy();

      // Publish the artifacts before the definition references them.
      const published = yield* stack.deploy(withIdentity);
      yield* uploadVhd({
        resourceGroupName: published.group.resourceGroupName,
        publisherName: published.publisher.publisherName,
        artifactStoreName: published.vhdStore.artifactStoreName,
        artifactManifestName: published.vhdManifest.artifactManifestName,
      });
      yield* uploadTemplate({
        resourceGroupName: published.group.resourceGroupName,
        publisherName: published.publisher.publisherName,
        artifactStoreName: published.store.artifactStoreName,
        artifactManifestName: published.manifest.artifactManifestName,
      });

      const { group, nf } = yield* stack.deploy(
        program({ region: "one", tags: { env: "one" } }),
      );
      const get = Effect.gen(function* () {
        return yield* hybridnetwork.GetNetworkFunction({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          networkFunctionName: nf.networkFunctionName,
        });
      });
      const observed = yield* get;
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(JSON.parse(observed.properties?.deploymentValues ?? "{}")).toEqual(
        { region: "one" },
      );
      expect(observed.tags?.env).toEqual("one");

      // In-place: deployment values (redeploy) and tags.
      const updated = yield* stack.deploy(
        program({ region: "two", tags: { env: "two" } }),
      );
      expect(updated.nf.networkFunctionId).toEqual(nf.networkFunctionId);
      const reobserved = yield* get;
      expect(
        JSON.parse(reobserved.properties?.deploymentValues ?? "{}"),
      ).toEqual({ region: "two" });
      expect(reobserved.tags?.env).toEqual("two");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 2_700_000 },
);
