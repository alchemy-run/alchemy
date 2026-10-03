import * as resources from "@distilled.cloud/azure/resources";
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

/** A just-in-time access approver. */
export interface ApplicationJitApprover {
  /** Object ID of the approving user or group. */
  id: string;
  /** Approver type: `user` or `group`. */
  type?: "user" | "group";
  /** Display name of the approver. */
  displayName?: string;
}

/** Just-in-time access policy for the publisher. */
export interface ApplicationJitAccessPolicy {
  /** Whether JIT access is enabled. */
  jitAccessEnabled: boolean;
  /** Approval mode: `AutoApprove` or `ManualApprove`. */
  jitApprovalMode?: "AutoApprove" | "ManualApprove";
  /** Approvers of JIT requests. */
  jitApprovers?: ApplicationJitApprover[];
  /** Maximum JIT access duration as an ISO 8601 period, e.g. `PT8H`. */
  maximumJitAccessDuration?: string;
}

/** Marketplace plan of a `MarketPlace` application. */
export interface ApplicationPlan {
  /** Plan name. */
  name: string;
  /** Publisher ID. */
  publisher: string;
  /** Product (offer) code. */
  product: string;
  /** Plan version. */
  version: string;
  /** Promotion code. */
  promotionCode?: string;
}

export interface ApplicationProps {
  /**
   * Resource group the application is created in. Changing it replaces the
   * application.
   */
  resourceGroup: string;
  /**
   * Name of the application, 3-64 characters. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * application.
   */
  name?: string;
  /**
   * Azure location of the application. Changing it replaces the
   * application.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * `ServiceCatalog` (deployed from an `ApplicationDefinition`) or
   * `MarketPlace` (deployed from a marketplace `plan`). Changing it replaces
   * the application.
   * @default "ServiceCatalog"
   */
  kind?: "ServiceCatalog" | "MarketPlace";
  /**
   * Resource ID of the `ApplicationDefinition` to deploy. Required for
   * `ServiceCatalog` applications. Changing it replaces the application.
   */
  applicationDefinitionId?: string;
  /**
   * Name of the managed resource group the resource provider creates to
   * hold the application's resources. It must not exist yet. Changing it
   * replaces the application.
   * @default `mrg-<application name>`
   */
  managedResourceGroupName?: string;
  /**
   * Values for the main template's parameters, keyed by parameter name.
   * Changing them redeploys the template in place.
   */
  parameters?: Record<string, unknown>;
  /** Publisher just-in-time access policy. */
  jitAccessPolicy?: ApplicationJitAccessPolicy;
  /**
   * Marketplace plan; required for `MarketPlace` applications. Changing it
   * replaces the application.
   */
  plan?: ApplicationPlan;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Application extends Resource<
  "Azure.ManagedApplications.Application",
  ApplicationProps,
  {
    /** Name of the application. */
    applicationName: string;
    /** Resource group that holds the application. */
    resourceGroup: string;
    /** ARM resource ID of the application. */
    applicationId: string;
    /** Location of the application. */
    location: string;
    /** Application kind. */
    kind: string;
    /** Resource ID of the deployed definition. */
    applicationDefinitionId: string | undefined;
    /** ARM resource ID of the managed resource group. */
    managedResourceGroupId: string;
    /** Name of the managed resource group. */
    managedResourceGroupName: string;
    /** Provisioning state, `Succeeded` once deployed. */
    provisioningState: string | undefined;
    /** Outputs of the main template, keyed by output name. */
    outputs: Record<string, unknown>;
    /** Tenant ID of the publisher. */
    publisherTenantId: string | undefined;
    /** Marketplace plan, if any. */
    plan: ApplicationPlan | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A managed application — an instance of an `ApplicationDefinition` (or a
 * marketplace offer) whose resources Azure deploys into a dedicated managed
 * resource group that the publisher manages.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/managed-applications/overview
 *
 * ### Deploying a Managed Application
 * **Example:** Application from a service catalog definition
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("apps");
 * const definition = yield* Azure.ManagedApplications.ApplicationDefinition(
 *   "storage-app",
 *   { resourceGroup: group.resourceGroupName, mainTemplate, createUiDefinition },
 * );
 * const app = yield* Azure.ManagedApplications.Application("customer-a", {
 *   resourceGroup: group.resourceGroupName,
 *   applicationDefinitionId: definition.applicationDefinitionId,
 * });
 * ```
 *
 * ### Passing Template Parameters
 * **Example:** Set parameters of the definition's main template
 * ```typescript
 * const app = yield* Azure.ManagedApplications.Application("customer-a", {
 *   resourceGroup: group.resourceGroupName,
 *   applicationDefinitionId: definition.applicationDefinitionId,
 *   managedResourceGroupName: "customer-a-resources",
 *   parameters: { storageSku: "Standard_LRS" },
 * });
 * ```
 *
 * @resource
 */
export const Application = Resource<Application>(
  "Azure.ManagedApplications.Application",
);

type ObservedApplication = solutions.GetApplicationResponse;

const makeName = (id: string) => createPhysicalName({ id, maxLength: 64 });

const getApplication = (
  subscriptionId: string,
  resourceGroupName: string,
  applicationName: string,
) =>
  orUndefinedIfNotFound(
    solutions.GetApplication({
      subscriptionId,
      resourceGroupName,
      applicationName,
    }),
  );

const getResourceGroup = (subscriptionId: string, resourceGroupName: string) =>
  orUndefinedIfNotFound(
    resources.GetResourceGroup({ subscriptionId, resourceGroupName }),
  );

const managedGroupId = (subscriptionId: string, name: string) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${name}`;

const lastSegment = (armId: string | undefined) =>
  armId
    ?.split("/")
    .filter((part) => part.length > 0)
    .pop() ?? "";

/** ARM wraps parameters and outputs as `{ name: { type?, value } }`. */
const unwrapValues = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      typeof entry === "object" && entry !== null && "value" in entry
        ? (entry as { value: unknown }).value
        : entry,
    ]),
  );
};

const wrapValues = (values: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, { value }]),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  app: ObservedApplication,
): Application["Attributes"] => ({
  applicationName: name,
  resourceGroup,
  applicationId: app.id ?? "",
  location: app.location ?? "",
  kind: app.kind,
  applicationDefinitionId: app.properties.applicationDefinitionId,
  managedResourceGroupId: app.properties.managedResourceGroupId ?? "",
  managedResourceGroupName: lastSegment(app.properties.managedResourceGroupId),
  provisioningState: app.properties.provisioningState,
  outputs: unwrapValues(app.properties.outputs),
  publisherTenantId: app.properties.publisherTenantId,
  plan: app.plan,
  tags: userTags(app.tags),
});

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    stables: [
      "applicationName",
      "resourceGroup",
      "applicationId",
      "location",
      "kind",
      "managedResourceGroupId",
      "managedResourceGroupName",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* solutions
        .ListApplicationBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListApplicationBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((app) => {
        const group = resourceGroupOf(app.id);
        return hasAnyAlchemyTag(app.tags) &&
          group !== undefined &&
          app.name !== undefined
          ? [toAttrs(group, app.name, app)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.applicationName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase()) ||
        (news.kind ?? "ServiceCatalog").toLowerCase() !==
          output.kind.toLowerCase() ||
        !sameId(news.applicationDefinitionId, output.applicationDefinitionId) ||
        (news.managedResourceGroupName !== undefined &&
          news.managedResourceGroupName.toLowerCase() !==
            output.managedResourceGroupName.toLowerCase()) ||
        stableStringify(news.plan) !== stableStringify(output.plan)
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
        output?.applicationName ?? olds?.name ?? (yield* makeName(id));
      const observed = yield* getApplication(
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
        news.name ?? output?.applicationName ?? (yield* makeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const managedGroupName =
        news.managedResourceGroupName ??
        output?.managedResourceGroupName ??
        `mrg-${name}`.slice(0, 90);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        applicationName: name,
      };
      const label = `managed application ${name}`;
      const get = getApplication(subscriptionId, resourceGroup, name);
      // Deploying the template into the managed group can take minutes.
      const waitProvisioned = waitForProvisioned(
        label,
        get,
        (app) => app.properties.provisioningState,
        { interval: "5 seconds", times: 120 },
      );

      const put = (location: string) =>
        solutions.ApplicationsCreateOrUpdate({
          ...where,
          location,
          kind: news.kind ?? "ServiceCatalog",
          tags,
          plan: news.plan,
          properties: {
            applicationDefinitionId: news.applicationDefinitionId,
            managedResourceGroupId: managedGroupId(
              subscriptionId,
              managedGroupName,
            ),
            parameters:
              news.parameters === undefined
                ? undefined
                : wrapValues(news.parameters),
            jitAccessPolicy: news.jitAccessPolicy,
          },
        });

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT is a long-running operation; the provider creates
      // the managed resource group and deploys the main template.
      if (observed === undefined) {
        yield* put(location);
      }
      observed = yield* waitProvisioned;

      // Sync parameters and JIT policy against observed state. PATCH
      // accepts but ignores them, so a changed value is applied by
      // re-sending the full PUT, which redeploys the main template.
      const observedParams = unwrapValues(observed.properties.parameters);
      const paramsChanged =
        news.parameters !== undefined &&
        Object.entries(news.parameters).some(
          ([key, value]) =>
            stableStringify(observedParams[key]) !== stableStringify(value),
        );
      const jitChanged =
        news.jitAccessPolicy !== undefined &&
        stableStringify(observed.properties.jitAccessPolicy) !==
          stableStringify(news.jitAccessPolicy);
      if (paramsChanged || jitChanged) {
        yield* put(observed.location ?? location);
        observed = yield* waitProvisioned;
      }

      // Sync tags against observed.
      if (tagsDiffer(observed.tags, tags)) {
        yield* solutions.UpdateApplication({ ...where, tags });
        observed = yield* waitProvisioned;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        solutions.DeleteApplication({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          applicationName: output.applicationName,
        }),
      );
      yield* waitUntilGone(
        `managed application ${output.applicationName}`,
        getApplication(
          subscriptionId,
          output.resourceGroup,
          output.applicationName,
        ),
        { interval: "5 seconds", times: 120 },
      );
      // The resource provider deletes the managed resource group with the
      // application; wait so nothing it held outlives the delete.
      if (output.managedResourceGroupName !== "") {
        yield* waitUntilGone(
          `managed resource group ${output.managedResourceGroupName}`,
          getResourceGroup(subscriptionId, output.managedResourceGroupName),
          { interval: "5 seconds", times: 120 },
        );
      }
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.ManagedApplications.ApplicationDefinition",
      ],
    },
  });
