import * as solutions from "@distilled.cloud/azure/solutions";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { stableStringify } from "../../Util/stable.ts";
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

/** A principal the publisher grants access to the managed resource group. */
export interface ApplicationDefinitionAuthorization {
  /**
   * Object ID of the user, group, or service principal that manages the
   * application's resources.
   */
  principalId: string;
  /**
   * GUID of the role definition granted to `principalId` on the managed
   * resource group (e.g. `acdd72a7-3385-48ef-bd42-f606fba81ae7` for
   * Reader). The role must not allow deleting the resource group, so Owner
   * is rejected.
   */
  roleDefinitionId: string;
}

/** A file the portal uses to build the application's create experience. */
export interface ApplicationDefinitionArtifact {
  /**
   * Artifact name: `ApplicationResourceTemplate`, `CreateUiDefinition`, or
   * `MainTemplateParameters`.
   */
  name: string;
  /** Blob URI of the artifact. */
  uri: string;
  /** Artifact type: `Template` or `Custom`. */
  type: string;
}

/** An Azure Policy assigned on the managed resource group. */
export interface ApplicationDefinitionPolicy {
  /** Name of the policy assignment. */
  name?: string;
  /** Resource ID of the policy definition. */
  policyDefinitionId?: string;
  /** Policy parameters as a JSON string. */
  parameters?: string;
}

export interface ApplicationDefinitionProps {
  /**
   * Resource group the definition is created in. Changing it replaces the
   * definition.
   */
  resourceGroup: string;
  /**
   * Name of the definition, 3-64 characters. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * definition.
   */
  name?: string;
  /**
   * Azure location of the definition. Changing it replaces the definition.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Lock the publisher places on the managed resource group of every
   * application: `None`, `CanNotDelete`, or `ReadOnly`.
   * @default "None"
   */
  lockLevel?: "None" | "CanNotDelete" | "ReadOnly";
  /** Display name shown in the service catalog. */
  displayName?: string;
  /** Description shown in the service catalog. */
  description?: string;
  /**
   * Whether customers can deploy new applications from this definition.
   * @default true
   */
  isEnabled?: boolean;
  /**
   * Principals the publisher grants access to each application's managed
   * resource group.
   */
  authorizations?: ApplicationDefinitionAuthorization[];
  /**
   * URI of a `.zip` package containing `mainTemplate.json` and
   * `createUiDefinition.json`. Use either this or `mainTemplate` +
   * `createUiDefinition`.
   */
  packageFileUri?: string;
  /**
   * Inline ARM template deployed into the managed resource group of each
   * application.
   */
  mainTemplate?: Record<string, unknown>;
  /** Inline `createUiDefinition.json` for the portal experience. */
  createUiDefinition?: Record<string, unknown>;
  /** Additional artifacts the portal uses. */
  artifacts?: ApplicationDefinitionArtifact[];
  /** Webhook URIs notified about application lifecycle events. */
  notificationEndpoints?: string[];
  /** Actions excluded from the deny assignment on the managed resource group. */
  lockingAllowedActions?: string[];
  /**
   * Data actions excluded from the deny assignment on the managed resource
   * group.
   */
  lockingAllowedDataActions?: string[];
  /** ARM deployment mode of the main template: `Incremental` or `Complete`. */
  deploymentMode?: "Incremental" | "Complete";
  /**
   * Publisher access to the managed resource group: `Managed` (publisher
   * manages it) or `Unmanaged`.
   */
  managementMode?: "Managed" | "Unmanaged";
  /** Azure Policies assigned on each managed resource group. */
  policies?: ApplicationDefinitionPolicy[];
  /**
   * Resource ID of a storage account to hold the definition package (bring
   * your own storage). Changing it replaces the definition.
   */
  storageAccountId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ApplicationDefinition extends Resource<
  "Azure.ManagedApplications.ApplicationDefinition",
  ApplicationDefinitionProps,
  {
    /** Name of the definition. */
    applicationDefinitionName: string;
    /** Resource group that holds the definition. */
    resourceGroup: string;
    /**
     * ARM resource ID of the definition; pass it as the
     * `applicationDefinitionId` of an `Application`.
     */
    applicationDefinitionId: string;
    /** Location of the definition. */
    location: string;
    /** Lock level placed on managed resource groups. */
    lockLevel: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** Whether new applications can be deployed from the definition. */
    isEnabled: boolean | undefined;
    /** Bring-your-own storage account ID, if any. */
    storageAccountId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A managed application definition — a service catalog entry that packages
 * an ARM template (and portal UI) so applications can be deployed from it
 * into publisher-managed resource groups.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/managed-applications/overview
 *
 * ### Creating a Definition
 * **Example:** Definition with an inline template
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("catalog");
 * const definition = yield* Azure.ManagedApplications.ApplicationDefinition(
 *   "storage-app",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     displayName: "Storage app",
 *     description: "A managed storage application",
 *     mainTemplate: {
 *       $schema:
 *         "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
 *       contentVersion: "1.0.0.0",
 *       resources: [],
 *     },
 *     createUiDefinition: {
 *       $schema:
 *         "https://schema.management.azure.com/schemas/0.1.2-preview/CreateUIDefinition.MultiVm.json#",
 *       handler: "Microsoft.Azure.CreateUIDef",
 *       version: "0.1.2-preview",
 *       parameters: { basics: [], steps: [], outputs: {} },
 *     },
 *   },
 * );
 * ```
 *
 * ### Granting Publisher Access
 * **Example:** Let an identity read every managed resource group
 * ```typescript
 * const definition = yield* Azure.ManagedApplications.ApplicationDefinition(
 *   "storage-app",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     lockLevel: "ReadOnly",
 *     authorizations: [
 *       {
 *         principalId: identity.principalId,
 *         roleDefinitionId: "acdd72a7-3385-48ef-bd42-f606fba81ae7",
 *       },
 *     ],
 *     packageFileUri: "https://example.blob.core.windows.net/apps/app.zip",
 *   },
 * );
 * ```
 *
 * @resource
 */
export const ApplicationDefinition = Resource<ApplicationDefinition>(
  "Azure.ManagedApplications.ApplicationDefinition",
);

type ObservedDefinition = solutions.GetApplicationDefinitionResponse;

const makeName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const getDefinition = (
  subscriptionId: string,
  resourceGroupName: string,
  applicationDefinitionName: string,
) =>
  orUndefinedIfNotFound(
    solutions.GetApplicationDefinition({
      subscriptionId,
      resourceGroupName,
      applicationDefinitionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  definition: ObservedDefinition,
): ApplicationDefinition["Attributes"] => ({
  applicationDefinitionName: name,
  resourceGroup,
  applicationDefinitionId: definition.id ?? "",
  location: definition.location ?? "",
  lockLevel: definition.properties.lockLevel,
  displayName: definition.properties.displayName,
  description: definition.properties.description,
  isEnabled: definition.properties.isEnabled,
  storageAccountId: definition.properties.storageAccountId,
  tags: userTags(definition.tags),
});

/** Desired definition properties from props (undefined fields omitted). */
const desiredProperties = (
  news: ApplicationDefinitionProps,
): solutions.ApplicationDefinitionProperties => ({
  lockLevel: news.lockLevel ?? "None",
  displayName: news.displayName,
  description: news.description,
  isEnabled: news.isEnabled,
  authorizations: news.authorizations,
  artifacts: news.artifacts,
  packageFileUri: news.packageFileUri,
  storageAccountId: news.storageAccountId,
  mainTemplate: news.mainTemplate,
  createUiDefinition: news.createUiDefinition,
  notificationPolicy:
    news.notificationEndpoints === undefined
      ? undefined
      : {
          notificationEndpoints: news.notificationEndpoints.map((uri) => ({
            uri,
          })),
        },
  lockingPolicy:
    news.lockingAllowedActions === undefined &&
    news.lockingAllowedDataActions === undefined
      ? undefined
      : {
          allowedActions: news.lockingAllowedActions,
          allowedDataActions: news.lockingAllowedDataActions,
        },
  deploymentPolicy:
    news.deploymentMode === undefined
      ? undefined
      : { deploymentMode: news.deploymentMode },
  managementPolicy:
    news.managementMode === undefined
      ? undefined
      : { mode: news.managementMode },
  policies: news.policies,
});

/** Inline JSON may come back as a string or an object. */
const asJson = (value: unknown) =>
  typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return value;
        }
      })()
    : value;

/**
 * Whether the observed properties differ from the desired ones. Only fields
 * the user set are compared, so server-filled defaults never cause drift.
 */
const propertiesDiffer = (
  observed: solutions.ApplicationDefinitionProperties,
  desired: solutions.ApplicationDefinitionProperties,
) =>
  (Object.keys(desired) as (keyof typeof desired)[]).some((key) => {
    const want = desired[key];
    if (want === undefined) return false;
    const have = observed[key];
    if (key === "mainTemplate" || key === "createUiDefinition") {
      // GET may omit the inline template; nothing to compare against.
      if (have === undefined) return false;
      return stableStringify(asJson(have)) !== stableStringify(want);
    }
    if (typeof want === "string" && typeof have === "string") {
      return want.toLowerCase() !== have.toLowerCase();
    }
    return stableStringify(have) !== stableStringify(want);
  });

export const ApplicationDefinitionProvider = () =>
  Provider.succeed(ApplicationDefinition, {
    stables: [
      "applicationDefinitionName",
      "resourceGroup",
      "applicationDefinitionId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* solutions
        .ListApplicationDefinitionBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListApplicationDefinitionBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((definition) => {
        const group = resourceGroupOf(definition.id);
        return hasAnyAlchemyTag(definition.tags) &&
          group !== undefined &&
          definition.name !== undefined
          ? [toAttrs(group, definition.name, definition)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.applicationDefinitionName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase()) ||
        (news.storageAccountId ?? "").toLowerCase() !==
          (output.storageAccountId ?? "").toLowerCase()
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
        output?.applicationDefinitionName ??
        olds?.name ??
        (yield* makeName(id));
      const observed = yield* getDefinition(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Solutions");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.applicationDefinitionName ?? (yield* makeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const properties = desiredProperties(news);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        applicationDefinitionName: name,
      };

      const label = `managed application definition ${name}`;
      const get = getDefinition(subscriptionId, resourceGroup, name);
      // The definition has no provisioning state: readable means ready.
      const waitReadable = waitForProvisioned(label, get, () => undefined, {
        times: 20,
      });

      // Observe.
      let observed = yield* get;

      // Ensure + sync properties: the PUT is a synchronous full upsert.
      if (
        observed === undefined ||
        propertiesDiffer(observed.properties, properties)
      ) {
        yield* solutions.ApplicationDefinitionsCreateOrUpdate({
          ...where,
          location: observed?.location ?? location,
          tags,
          properties,
        });
        observed = yield* waitReadable;
      }

      // Sync tags against observed.
      if (tagsDiffer(observed.tags, tags)) {
        yield* solutions.UpdateApplicationDefinition({ ...where, tags });
        observed = yield* waitReadable;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        solutions.DeleteApplicationDefinition({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          applicationDefinitionName: output.applicationDefinitionName,
        }),
      );
      yield* waitUntilGone(
        `managed application definition ${output.applicationDefinitionName}`,
        getDefinition(
          subscriptionId,
          output.resourceGroup,
          output.applicationDefinitionName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
