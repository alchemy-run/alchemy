import * as resources from "@distilled.cloud/azure/resources";
import * as Data from "effect/Data";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  fromParameterValues,
  sameId,
  sameJson,
  toParameterValues,
} from "./Shared.ts";

/** Reference to a template stored outside the stack request. */
export interface DeploymentStackTemplateLink {
  /**
   * ARM ID of a template spec version, e.g.
   * `version.templateSpecVersionId`.
   */
  id?: string;
  /** URI of a template file. */
  uri?: string;
  /** Expected `contentVersion` of the linked template. */
  contentVersion?: string;
}

/** What happens to resources the stack stops managing. */
export interface DeploymentStackActionOnUnmanage {
  /**
   * Resources removed from the template (or left behind when the stack is
   * deleted) are deleted or detached.
   */
  resources: "delete" | "detach";
  /**
   * Resource groups removed from the template are deleted or detached.
   * @default same as `resources`
   */
  resourceGroups?: "delete" | "detach";
  /**
   * Resources that do not support deletion are detached, or fail the
   * operation.
   */
  resourcesWithoutDeleteSupport?: "detach" | "fail";
}

/** Deny assignments that protect the managed resources. */
export interface DeploymentStackDenySettings {
  /**
   * `none` adds no deny assignment; `denyDelete` blocks deletes;
   * `denyWriteAndDelete` blocks writes and deletes.
   */
  mode: "none" | "denyDelete" | "denyWriteAndDelete";
  /** Entra principal IDs exempt from the deny assignment (up to 5). */
  excludedPrincipals?: string[];
  /** Management operations exempt from the deny assignment (up to 200). */
  excludedActions?: string[];
  /** Apply the deny assignment to child scopes of each managed resource. */
  applyToChildScopes?: boolean;
}

export interface DeploymentStackProps {
  /** Resource group the stack lives in. Changing it replaces the stack. */
  resourceGroup: string;
  /**
   * Name of the deployment stack. At most 90 characters of letters,
   * digits, `-`, `_`, `.`, and `()`. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the stack.
   */
  name?: string;
  /** The ARM template (JSON). Set exactly one of `template` or `templateLink`. */
  template?: Record<string, unknown>;
  /** A linked template (template spec version or URI). */
  templateLink?: DeploymentStackTemplateLink;
  /** Template parameter values, e.g. `{ prefix: "app" }`. */
  parameters?: Record<string, unknown>;
  /**
   * What happens to resources the stack stops managing — on update when
   * they leave the template, and on delete for all of them.
   * @default { resources: "delete", resourceGroups: "delete" }
   */
  actionOnUnmanage?: DeploymentStackActionOnUnmanage;
  /**
   * Deny assignment applied to the managed resources.
   * @default { mode: "none" }
   */
  denySettings?: DeploymentStackDenySettings;
  /** Description of the stack (at most 4096 characters). */
  description?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface DeploymentStack extends Resource<
  "Azure.Resources.DeploymentStack",
  DeploymentStackProps,
  {
    /** Name of the deployment stack. */
    deploymentStackName: string;
    /** ARM ID of the deployment stack. */
    deploymentStackId: string;
    /** Resource group of the stack. */
    resourceGroup: string;
    /** Template outputs, e.g. `{ identityId: "/subscriptions/..." }`. */
    outputs: Record<string, unknown>;
    /** ARM IDs of the resources the stack currently manages. */
    managedResources: string[];
    /** ARM ID of the deployment the last stack update ran. */
    deploymentId: string | undefined;
    /** Provisioning state of the stack (`succeeded`). */
    provisioningState: string | undefined;
    /** Correlation ID of the last stack operation. */
    correlationId: string | undefined;
    /** Unmanage behaviour applied when the stack is deleted. */
    actionOnUnmanage: DeploymentStackActionOnUnmanage;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure deployment stack — deploys an ARM template into a resource group
 * and keeps managing the resources it created: resources removed from the
 * template are deleted (or detached), and deleting the stack deletes
 * everything it manages. Optional deny settings protect the managed
 * resources from out-of-band changes.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/bicep/deployment-stacks
 *
 * ### Managing Resources with a Stack
 * **Example:** Stack that owns a user-assigned identity
 * ```typescript
 * const stack = yield* Azure.Resources.DeploymentStack("identities", {
 *   resourceGroup: group.resourceGroupName,
 *   template: {
 *     $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
 *     contentVersion: "1.0.0.0",
 *     resources: [
 *       {
 *         type: "Microsoft.ManagedIdentity/userAssignedIdentities",
 *         apiVersion: "2023-01-31",
 *         name: "app-identity",
 *         location: "[resourceGroup().location]",
 *       },
 *     ],
 *   },
 * });
 * // stack.managedResources lists the identity's ARM ID
 * ```
 *
 * ### Protecting Managed Resources
 * **Example:** Deny deletes outside the stack
 * ```typescript
 * yield* Azure.Resources.DeploymentStack("protected", {
 *   resourceGroup: group.resourceGroupName,
 *   templateLink: { id: version.templateSpecVersionId },
 *   denySettings: { mode: "denyDelete" },
 *   actionOnUnmanage: { resources: "detach" },
 * });
 * ```
 *
 * @resource
 */
export const DeploymentStack = Resource<DeploymentStack>(
  "Azure.Resources.DeploymentStack",
);

export class DeploymentStackFailed extends Data.TaggedError(
  "Azure.Resources.DeploymentStackFailed",
)<{
  readonly deploymentStack: string;
  readonly code: string | undefined;
  readonly message: string;
}> {}

const DEFAULT_UNMANAGE: DeploymentStackActionOnUnmanage = {
  resources: "delete",
  resourceGroups: "delete",
};

const stackNameOf = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 90 });

const getStack = (
  subscriptionId: string,
  resourceGroupName: string,
  deploymentStackName: string,
) =>
  orUndefinedIfNotFound(
    resources.GetDeploymentStackAtResourceGroup({
      subscriptionId,
      resourceGroupName,
      deploymentStackName,
    }),
  );

const toUnmanage = (
  observed: resources.ActionOnUnmanage | undefined,
): DeploymentStackActionOnUnmanage => ({
  resources: observed?.resources === "detach" ? "detach" : "delete",
  ...(observed?.resourceGroups === undefined
    ? {}
    : {
        resourceGroups:
          observed.resourceGroups === "detach" ? "detach" : "delete",
      }),
  ...(observed?.resourcesWithoutDeleteSupport === undefined
    ? {}
    : {
        resourcesWithoutDeleteSupport:
          observed.resourcesWithoutDeleteSupport === "fail" ? "fail" : "detach",
      }),
});

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
  observed: resources.GetDeploymentStackAtResourceGroupResponse,
): DeploymentStack["Attributes"] => ({
  deploymentStackName: name,
  deploymentStackId:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/deploymentStacks/${name}`,
  resourceGroup,
  outputs: fromParameterValues(observed.properties?.outputs),
  managedResources: (observed.properties?.resources ?? []).flatMap(
    (resource) => (resource.id === undefined ? [] : [resource.id]),
  ),
  deploymentId: observed.properties?.deploymentId,
  provisioningState: observed.properties?.provisioningState,
  correlationId: observed.properties?.correlationId,
  actionOnUnmanage: toUnmanage(observed.properties?.actionOnUnmanage),
  tags: userTags(observed.tags),
});

/** Stack states are camelCase (`succeeded`); the shared poller expects PascalCase. */
const pascalState = (state: string | undefined) =>
  state === undefined ? undefined : state[0]!.toUpperCase() + state.slice(1);

const SETTLED = new Set(["succeeded", "failed", "canceled"]);

/** Poll until the stack operation settles; a failed run surfaces ARM's error. */
const waitForStack = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) =>
  waitForProvisioned(
    `deployment stack ${name}`,
    getStack(subscriptionId, resourceGroup, name),
    (stack) => pascalState(stack.properties?.provisioningState),
    { interval: "5 seconds", times: 96 },
  ).pipe(
    Effect.catchTag("Azure.ProvisioningFailed", (failure) =>
      getStack(subscriptionId, resourceGroup, name).pipe(
        Effect.flatMap((stack) => {
          const error = stack?.properties?.error;
          const details = (error?.details ?? [])
            .map((detail) => `${detail.code}: ${detail.message}`)
            .join("; ");
          return Effect.fail(
            new DeploymentStackFailed({
              deploymentStack: name,
              code: error?.code,
              message: `deployment stack ${name} ended in state '${failure.state}': ${error?.message ?? "no error details"}${details ? ` (${details})` : ""}`,
            }),
          );
        }),
      ),
    ),
  );

const sameStrings = (a: string[] | undefined, b: string[] | undefined) =>
  sameJson([...(a ?? [])].sort(), [...(b ?? [])].sort());

export const DeploymentStackProvider = () =>
  Provider.succeed(DeploymentStack, {
    stables: ["deploymentStackName", "deploymentStackId", "resourceGroup"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const groups = yield* resources
        .ListResourceGroups({
          subscriptionId,
          _filter: "tagName eq 'alchemy::stack'",
        })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListResourceGroups", page),
          ),
        );
      const perGroup = yield* Effect.forEach(
        (groups.value ?? []).flatMap((group) =>
          group.name === undefined ? [] : [group.name],
        ),
        (resourceGroupName) =>
          orUndefinedIfNotFound(
            resources
              .ListDeploymentStackAtResourceGroup({
                subscriptionId,
                resourceGroupName,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListDeploymentStackAtResourceGroup", page),
                ),
              ),
          ).pipe(
            Effect.map((page) =>
              (page?.value ?? []).flatMap((stack) =>
                stack.name !== undefined && hasAnyAlchemyTag(stack.tags)
                  ? [
                      toAttrs(
                        subscriptionId,
                        resourceGroupName,
                        stack.name,
                        stack,
                      ),
                    ]
                  : [],
              ),
            ),
          ),
        { concurrency: 4 },
      );
      return perGroup.flat();
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news.resourceGroup))
        return { action: "replace" } as const;
      if (!isResolved(news)) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.deploymentStackName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const group = output?.resourceGroup ?? olds?.resourceGroup;
      if (group === undefined) return undefined;
      const name =
        output?.deploymentStackName ?? (yield* stackNameOf(id, olds?.name));
      const observed = yield* getStack(subscriptionId, group, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, group, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Resources");
      const group = news.resourceGroup;
      const name =
        output?.deploymentStackName ?? (yield* stackNameOf(id, news.name));
      const tags = yield* desiredTags(id, news.tags);
      const actionOnUnmanage = news.actionOnUnmanage ?? DEFAULT_UNMANAGE;
      const denySettings = news.denySettings ?? { mode: "none" as const };

      // Observe. An operation still in flight settles first.
      let observed = yield* getStack(subscriptionId, group, name);
      if (
        observed !== undefined &&
        !SETTLED.has(observed.properties?.provisioningState ?? "succeeded")
      ) {
        observed = yield* waitForStack(subscriptionId, group, name).pipe(
          Effect.catchTag("Azure.Resources.DeploymentStackFailed", () =>
            getStack(subscriptionId, group, name),
          ),
        );
      }

      // Each PUT redeploys the template, so only write when the observed
      // stack differs from the desired one (or the last run failed).
      const current = observed?.properties;
      let templateMatches = true;
      if (news.template !== undefined && observed !== undefined) {
        const exported = yield* orUndefinedIfNotFound(
          resources.ExportDeploymentStackTemplateAtResourceGroup({
            subscriptionId,
            resourceGroupName: group,
            deploymentStackName: name,
          }),
        );
        templateMatches = sameJson(exported?.template, news.template);
      } else if (news.templateLink !== undefined) {
        templateMatches =
          (news.templateLink.id === undefined ||
            sameId(current?.templateLink?.id, news.templateLink.id)) &&
          (news.templateLink.uri === undefined ||
            current?.templateLink?.uri === news.templateLink.uri);
      }
      const observedUnmanage = toUnmanage(current?.actionOnUnmanage);
      const desiredUnmanage = toUnmanage(actionOnUnmanage);
      if (
        observed === undefined ||
        current?.provisioningState !== "succeeded" ||
        !templateMatches ||
        !sameJson(
          fromParameterValues(current.parameters),
          news.parameters ?? {},
        ) ||
        observedUnmanage.resources !== desiredUnmanage.resources ||
        (desiredUnmanage.resourceGroups !== undefined &&
          observedUnmanage.resourceGroups !== desiredUnmanage.resourceGroups) ||
        (desiredUnmanage.resourcesWithoutDeleteSupport !== undefined &&
          observedUnmanage.resourcesWithoutDeleteSupport !==
            desiredUnmanage.resourcesWithoutDeleteSupport) ||
        current.denySettings.mode !== denySettings.mode ||
        !sameStrings(
          current.denySettings.excludedPrincipals,
          denySettings.excludedPrincipals,
        ) ||
        (denySettings.excludedActions !== undefined &&
          !sameStrings(
            current.denySettings.excludedActions?.filter(
              (action) =>
                action !== "*/read" &&
                action !== "Microsoft.Authorization/locks/delete",
            ),
            denySettings.excludedActions,
          )) ||
        (current.denySettings.applyToChildScopes ?? false) !==
          (denySettings.applyToChildScopes ?? false) ||
        (current.description ?? "") !== (news.description ?? "") ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* resources.DeploymentStacksCreateOrUpdateAtResourceGroup({
          subscriptionId,
          resourceGroupName: group,
          deploymentStackName: name,
          properties: {
            template: news.template,
            templateLink: news.templateLink,
            parameters: toParameterValues(news.parameters),
            actionOnUnmanage,
            denySettings,
            description: news.description,
          },
          tags,
        });
      }

      const fresh = yield* waitForStack(subscriptionId, group, name);
      return toAttrs(subscriptionId, group, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const unmanage = output.actionOnUnmanage ?? DEFAULT_UNMANAGE;
      yield* ignoreNotFound(
        resources.DeleteDeploymentStackAtResourceGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          deploymentStackName: output.deploymentStackName,
          unmanageAction_Resources: unmanage.resources,
          unmanageAction_ResourceGroups:
            unmanage.resourceGroups ?? unmanage.resources,
          unmanageAction_ResourcesWithoutDeleteSupport:
            unmanage.resourcesWithoutDeleteSupport,
        }),
      );
      // Deleting a stack also deletes the resources it manages.
      yield* waitUntilGone(
        `deployment stack ${output.deploymentStackName}`,
        getStack(
          subscriptionId,
          output.resourceGroup,
          output.deploymentStackName,
        ),
        { interval: "5 seconds", times: 96 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
