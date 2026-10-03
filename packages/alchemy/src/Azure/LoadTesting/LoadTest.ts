import * as loadtestservice from "@distilled.cloud/azure/loadtestservice";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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

export type LoadTestIdentityType =
  | "None"
  | "SystemAssigned"
  | "UserAssigned"
  | "SystemAssigned,UserAssigned";

export interface LoadTestIdentity {
  /** Kind of managed identity attached to the load test resource. */
  type: LoadTestIdentityType;
  /**
   * ARM resource IDs of user-assigned identities (required when `type`
   * includes `UserAssigned`).
   */
  userAssignedIdentities?: string[];
}

export interface LoadTestEncryption {
  /**
   * Key Vault key URL used as the key encryption key, versioned or
   * versionless, e.g. `https://vault.vault.azure.net/keys/kek`.
   */
  keyUrl: string;
  /** Managed identity used to reach the key. */
  identity: {
    /** Whether the system- or a user-assigned identity reads the key. */
    type: "SystemAssigned" | "UserAssigned";
    /** ARM resource ID of the user-assigned identity (when `type` is `UserAssigned`). */
    resourceId?: string;
  };
}

export interface LoadTestProps {
  /**
   * Resource group of the load test resource. Changing it replaces the
   * resource.
   */
  resourceGroup: string;
  /**
   * Name of the load test resource: letters, digits, hyphens, and
   * underscores. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the resource.
   */
  name?: string;
  /**
   * Azure region. Azure Load Testing is available in a subset of regions
   * (e.g. `eastus`, `eastus2`, `westus2`, `westus3`, `northeurope`,
   * `westeurope`). Changing it replaces the resource.
   * @default the stack's Azure location
   */
  location?: string;
  /** Description of the load test resource. */
  description?: string;
  /**
   * Managed identity of the resource, used for customer-managed keys and
   * Key Vault secret references in tests.
   * @default no identity
   */
  identity?: LoadTestIdentity;
  /**
   * Customer-managed key encryption. Can be changed once set but not
   * removed.
   * @default Microsoft-managed keys
   */
  encryption?: LoadTestEncryption;
  /** User tags. Alchemy ownership tags are merged in. */
  tags?: Record<string, string>;
}

export interface LoadTest extends Resource<
  "Azure.LoadTesting.LoadTest",
  LoadTestProps,
  {
    /** Name of the load test resource. */
    loadTestName: string;
    /** ARM resource ID of the load test resource. */
    loadTestId: string;
    /** Resource group of the load test resource. */
    resourceGroup: string;
    /** Region of the load test resource. */
    location: string;
    /**
     * Data-plane endpoint used to upload test plans and start test runs,
     * e.g. `{guid}.eastus.cnt-prod.loadtesting.azure.com`.
     */
    dataPlaneUri: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Provisioning state reported by ARM. */
    provisioningState: string | undefined;
    /** User tags (ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Load Testing resource: the top-level container for load tests,
 * test runs, and their results. Billing is per virtual-user hour of test
 * runs, so an idle resource costs nothing.
 *
 * @see https://learn.microsoft.com/azure/load-testing/overview-what-is-azure-load-testing
 *
 * ### Creating a Load Test Resource
 * **Example:** Load testing in East US
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("perf", {
 *   location: "eastus",
 * });
 * const load = yield* Azure.LoadTesting.LoadTest("load", {
 *   resourceGroup: group.resourceGroupName,
 *   description: "API load tests",
 * });
 * ```
 *
 * ### Identity and Encryption
 * **Example:** System-assigned identity for Key Vault secrets
 * ```typescript
 * const load = yield* Azure.LoadTesting.LoadTest("load", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * ```
 *
 * **Example:** Customer-managed key with a user-assigned identity
 * ```typescript
 * const load = yield* Azure.LoadTesting.LoadTest("load", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: {
 *     type: "UserAssigned",
 *     userAssignedIdentities: [identity.identityId],
 *   },
 *   encryption: {
 *     keyUrl: "https://my-vault.vault.azure.net/keys/kek",
 *     identity: { type: "UserAssigned", resourceId: identity.identityId },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const LoadTest = Resource<LoadTest>("Azure.LoadTesting.LoadTest");

type ObservedLoadTest = loadtestservice.GetLoadTestResponse;

const createLoadTestName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, lowercase: true, delimiter: "-" });

const getLoadTest = (
  subscriptionId: string,
  resourceGroupName: string,
  loadTestName: string,
) =>
  orUndefinedIfNotFound(
    loadtestservice.GetLoadTest({
      subscriptionId,
      resourceGroupName,
      loadTestName,
    }),
  );

const lower = (value: string | undefined) =>
  value?.toLowerCase().replaceAll(" ", "");

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: ObservedLoadTest,
): LoadTest["Attributes"] => ({
  loadTestName: name,
  loadTestId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  dataPlaneUri: observed.properties?.dataPlaneURI,
  principalId: observed.identity?.principalId,
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

const toRequestIdentity = (identity: LoadTestIdentity | undefined) =>
  identity === undefined
    ? { type: "None" }
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentities === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentities.map((id) => [id, {}]),
              ),
      };

const identityInSync = (
  desired: LoadTestIdentity | undefined,
  observed: ObservedLoadTest["identity"],
) => {
  if (lower(desired?.type ?? "None") !== lower(observed?.type ?? "None")) {
    return false;
  }
  const want = (desired?.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return want.length === have.length && want.every((id, i) => id === have[i]);
};

const encryptionInSync = (
  desired: LoadTestEncryption | undefined,
  observed: loadtestservice.EncryptionProperties | undefined,
) =>
  desired === undefined ||
  (desired.keyUrl === observed?.keyUrl &&
    lower(desired.identity.type) === lower(observed?.identity?.type) &&
    lower(desired.identity.resourceId) ===
      lower(observed?.identity?.resourceId ?? undefined));

export const LoadTestProvider = () =>
  Provider.succeed(LoadTest, {
    stables: ["loadTestName", "loadTestId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* loadtestservice
        .ListLoadTestBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListLoadTestBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((loadTest) => {
        const group = resourceGroupOf(loadTest.id);
        return hasAnyAlchemyTag(loadTest.tags) &&
          group !== undefined &&
          loadTest.name !== undefined
          ? [toAttrs(group, loadTest.name, loadTest)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.loadTestName)) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.loadTestName ?? olds?.name ?? (yield* createLoadTestName(id));
      const observed = yield* getLoadTest(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.LoadTestService");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.loadTestName ?? (yield* createLoadTestName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        loadTestName: name,
      };
      const label = `load test resource ${name}`;
      const get = getLoadTest(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* loadtestservice.LoadTestsCreateOrUpdate({
          ...where,
          location,
          tags,
          identity:
            news.identity === undefined
              ? undefined
              : toRequestIdentity(news.identity),
          properties: {
            description: news.description,
            encryption: news.encryption,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (loadTest) => loadTest.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Sync description, identity, encryption, and tags against observed.
      const descriptionChanged =
        news.description !== undefined &&
        news.description !== observed.properties?.description;
      const encryptionChanged = !encryptionInSync(
        news.encryption,
        observed.properties?.encryption,
      );
      const identityChanged = !identityInSync(news.identity, observed.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        descriptionChanged ||
        encryptionChanged ||
        identityChanged ||
        tagsChanged
      ) {
        yield* loadtestservice.UpdateLoadTest({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity: identityChanged
            ? toRequestIdentity(news.identity)
            : undefined,
          properties:
            descriptionChanged || encryptionChanged
              ? {
                  description: descriptionChanged
                    ? news.description
                    : undefined,
                  encryption: encryptionChanged ? news.encryption : undefined,
                }
              : undefined,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (loadTest) => loadTest.properties?.provisioningState,
          { interval: "5 seconds", times: 60 },
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        loadtestservice.DeleteLoadTest({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          loadTestName: output.loadTestName,
        }),
      );
      yield* waitUntilGone(
        `load test resource ${output.loadTestName}`,
        getLoadTest(subscriptionId, output.resourceGroup, output.loadTestName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
