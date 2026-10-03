import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { createHash } from "node:crypto";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createHybridNetworkName,
  type HybridNetworkIdentity,
  identityDiffers,
  identityRequest,
  NAMESPACE,
  retryInProgress,
  sameArm,
  sameJson,
  STORE_BUDGET,
} from "./Common.ts";

export type NetworkFunctionNfviType =
  | "AzureCore"
  | "AzureArcKubernetes"
  | "AzureOperatorNexus";

export interface NetworkFunctionProps {
  /** Resource group the network function is created in. Changing it replaces the function. */
  resourceGroup: string;
  /**
   * Network function name: 1-64 letters, digits, `_`, and `-`. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the function.
   */
  name?: string;
  /**
   * Azure location; must be an Azure Operator Service Manager region.
   * Changing it replaces the function.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the `NetworkFunctionDefinitionVersion` to deploy. Changing it
   * replaces the function.
   */
  networkFunctionDefinitionVersionId: string;
  /** Type of the NFVI the function is deployed onto. Changing it replaces the function. */
  nfviType: NetworkFunctionNfviType;
  /**
   * ID of the NFVI: an Azure resource group ID for `AzureCore`, or a custom
   * location ID for Arc Kubernetes / Operator Nexus. Changing it replaces
   * the function.
   */
  nfviId: string;
  /**
   * Deployment values as a JSON string conforming to the definition's
   * `deployParameters`. Updated in place. Mutually exclusive with
   * `secretDeploymentValues`.
   */
  deploymentValues?: string;
  /**
   * Deployment values as a JSON string stored as a secret. Azure never
   * returns it, so changes are detected by hash. Switching between open and
   * secret values replaces the function.
   */
  secretDeploymentValues?: string | Redacted.Redacted<string>;
  /**
   * Whether software updates are allowed during deployment.
   */
  allowSoftwareUpdate?: boolean;
  /** Role configuration override values (JSON strings). Updated in place. */
  roleOverrideValues?: string[];
  /** Managed identity the network function deploys with. */
  identity?: HybridNetworkIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkFunction extends Resource<
  "Azure.HybridNetwork.NetworkFunction",
  NetworkFunctionProps,
  {
    /** Name of the network function. */
    networkFunctionName: string;
    /** ARM resource ID of the network function. */
    networkFunctionId: string;
    /** Resource group that holds the network function. */
    resourceGroup: string;
    /** Location of the network function. */
    location: string;
    /** ARM ID of the deployed network function definition version. */
    networkFunctionDefinitionVersionId: string;
    /** NFVI type. */
    nfviType: string | undefined;
    /** NFVI ID. */
    nfviId: string | undefined;
    /** `Open` or `Secret`. */
    configurationType: "Open" | "Secret";
    /** Deployment values JSON (`Open` functions only). */
    deploymentValues: string | undefined;
    /** SHA-256 of the last applied secret deployment values (`Secret` only). */
    secretValueHash: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager network function — a deployment of a
 * published `NetworkFunctionDefinitionVersion` onto an NFVI (an Azure
 * resource group, an Arc-connected Kubernetes cluster, or Azure Operator
 * Nexus).
 *
 * Deployment values, role overrides, and identity update in place; the
 * definition version and NFVI are fixed for the life of the function.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/azure-operator-service-manager-overview
 *
 * ### Deploying a Network Function
 * **Example:** Virtual network function on Azure Core
 * ```typescript
 * const nf = yield* Azure.HybridNetwork.NetworkFunction("firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   networkFunctionDefinitionVersionId: nfdv.networkFunctionDefinitionVersionId,
 *   nfviType: "AzureCore",
 *   nfviId: target.resourceGroupId,
 *   deploymentValues: JSON.stringify({ vmSize: "Standard_B1s" }),
 * });
 * ```
 *
 * **Example:** Secret deployment values
 * ```typescript
 * const nf = yield* Azure.HybridNetwork.NetworkFunction("firewall", {
 *   resourceGroup: group.resourceGroupName,
 *   networkFunctionDefinitionVersionId: nfdv.networkFunctionDefinitionVersionId,
 *   nfviType: "AzureArcKubernetes",
 *   nfviId: customLocation.id,
 *   secretDeploymentValues: Redacted.make(
 *     JSON.stringify({ adminPassword: process.env.ADMIN_PASSWORD }),
 *   ),
 * });
 * ```
 *
 * @resource
 */
export const NetworkFunction = Resource<NetworkFunction>(
  "Azure.HybridNetwork.NetworkFunction",
);

const getFunction = (
  subscriptionId: string,
  resourceGroupName: string,
  networkFunctionName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetNetworkFunction({
      subscriptionId,
      resourceGroupName,
      networkFunctionName,
    }),
  );

const hashSecret = (value: string | Redacted.Redacted<string>) =>
  Effect.sync(() =>
    createHash("sha256")
      .update(Redacted.isRedacted(value) ? Redacted.value(value) : value)
      .digest("hex"),
  );

const typeOf = (props: {
  secretDeploymentValues?: unknown;
}): "Open" | "Secret" =>
  props.secretDeploymentValues !== undefined ? "Secret" : "Open";

const toAttrs = (
  resourceGroup: string,
  name: string,
  fn: hybridnetwork.GetNetworkFunctionResponse | hybridnetwork.NetworkFunction,
  secretValueHash: string | undefined,
): NetworkFunction["Attributes"] => {
  const configurationType =
    fn.properties?.configurationType === "Secret" ? "Secret" : "Open";
  return {
    networkFunctionName: name,
    networkFunctionId: fn.id ?? "",
    resourceGroup,
    location: fn.location,
    networkFunctionDefinitionVersionId:
      fn.properties?.networkFunctionDefinitionVersionResourceReference?.id ??
      "",
    nfviType: fn.properties?.nfviType,
    nfviId: fn.properties?.nfviId,
    configurationType,
    deploymentValues:
      configurationType === "Open" ? fn.properties?.deploymentValues : undefined,
    secretValueHash:
      configurationType === "Secret" ? secretValueHash : undefined,
    principalId: fn.identity?.principalId,
    tags: userTags(fn.tags),
  };
};

export const NetworkFunctionProvider = () =>
  Provider.succeed(NetworkFunction, {
    stables: [
      "networkFunctionName",
      "networkFunctionId",
      "resourceGroup",
      "location",
      "networkFunctionDefinitionVersionId",
      "nfviType",
      "nfviId",
      "configurationType",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* hybridnetwork
        .ListNetworkFunctionBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListNetworkFunctionBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((fn) => {
        const group = resourceGroupOf(fn.id);
        return hasAnyAlchemyTag(fn.tags) &&
          group !== undefined &&
          fn.name !== undefined
          ? [toAttrs(group, fn.name, fn, undefined)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameName =
        news.name === undefined || news.name === output.networkFunctionName;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameName ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(
          news.networkFunctionDefinitionVersionId,
          output.networkFunctionDefinitionVersionId,
        ) ||
        news.nfviType !== output.nfviType ||
        !sameArm(news.nfviId, output.nfviId) ||
        typeOf(news) !== output.configurationType
      ) {
        return {
          action: "replace",
          deleteFirst: news.name !== undefined && sameName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.networkFunctionName ??
        olds?.name ??
        (yield* createHybridNetworkName(id));
      const observed = yield* getFunction(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.secretValueHash,
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.networkFunctionName ??
        (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const configurationType = typeOf(news);
      const secret = news.secretDeploymentValues;
      const secretValueHash =
        secret === undefined ? undefined : yield* hashSecret(secret);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkFunctionName: name,
      };
      const get = getFunction(subscriptionId, resourceGroup, name);
      const label = `AOSM network function ${name}`;
      // Deployment values, role overrides, and identity are only writable
      // by PUT. Secret values are write-only: the hash of the last applied
      // value is the only observation available.
      const deploymentDiffers = (
        observed: hybridnetwork.GetNetworkFunctionResponse,
      ) =>
        (configurationType === "Secret"
          ? output?.secretValueHash !== secretValueHash
          : !sameJson(
              observed.properties?.deploymentValues,
              news.deploymentValues ?? "{}",
            )) ||
        (news.allowSoftwareUpdate !== undefined &&
          observed.properties?.allowSoftwareUpdate !==
            news.allowSoftwareUpdate) ||
        (news.roleOverrideValues !== undefined &&
          JSON.stringify(observed.properties?.roleOverrideValues ?? []) !==
            JSON.stringify(news.roleOverrideValues)) ||
        identityDiffers(observed.identity, news.identity);

      // Observe.
      let observed = yield* get;

      // Ensure (and sync the deployment, which is only writable by PUT).
      if (observed === undefined || deploymentDiffers(observed)) {
        yield* retryInProgress(
          hybridnetwork.NetworkFunctionsCreateOrUpdate({
            ...where,
            location: observed?.location ?? location,
            tags,
            identity: identityRequest(news.identity),
            properties: {
              networkFunctionDefinitionVersionResourceReference: {
                idType: "Open",
                id: news.networkFunctionDefinitionVersionId,
              },
              nfviType: news.nfviType,
              nfviId: news.nfviId,
              allowSoftwareUpdate: news.allowSoftwareUpdate,
              roleOverrideValues: news.roleOverrideValues,
              configurationType,
              ...(configurationType === "Secret"
                ? {
                    secretDeploymentValues: Redacted.isRedacted(secret)
                      ? Redacted.value(secret)
                      : secret,
                  }
                : { deploymentValues: news.deploymentValues ?? "{}" }),
            },
          }),
        );
      }
      // Deploying runs the definition's templates; allow several minutes.
      observed = yield* waitForProvisioned(
        label,
        get,
        (fn) => fn.properties?.provisioningState,
        STORE_BUDGET,
      );

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdateNetworkFunctionTags({ ...where, tags }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (fn) =>
            tagsDiffer(fn.tags, tags)
              ? "Updating"
              : fn.properties?.provisioningState,
          STORE_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed, secretValueHash);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork
          .DeleteNetworkFunction({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            networkFunctionName: output.networkFunctionName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM network function ${output.networkFunctionName}`,
        getFunction(
          subscriptionId,
          output.resourceGroup,
          output.networkFunctionName,
        ),
        STORE_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridNetwork.NetworkFunctionDefinitionVersion",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
