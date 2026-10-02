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

/** Reference to a template stored outside the deployment request. */
export interface DeploymentTemplateLink {
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

export interface DeploymentProps {
  /** Resource group to deploy into. Changing it replaces the deployment. */
  resourceGroup: string;
  /**
   * Name of the deployment. At most 64 characters of letters, digits, `-`,
   * `_`, `.`, and `()`. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the deployment.
   */
  name?: string;
  /** The ARM template (JSON). Set exactly one of `template` or `templateLink`. */
  template?: Record<string, unknown>;
  /** A linked template (template spec version or URI). */
  templateLink?: DeploymentTemplateLink;
  /** Template parameter values, e.g. `{ prefix: "app" }`. */
  parameters?: Record<string, unknown>;
  /**
   * `Incremental` leaves resources not in the template alone; `Complete`
   * deletes every resource in the group that the template does not
   * declare.
   * @default "Incremental"
   */
  mode?: "Incremental" | "Complete";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Deployment extends Resource<
  "Azure.Resources.Deployment",
  DeploymentProps,
  {
    /** Name of the deployment. */
    deploymentName: string;
    /** ARM ID of the deployment. */
    deploymentId: string;
    /** Resource group deployed into. */
    resourceGroup: string;
    /** Template outputs, e.g. `{ greeting: "hello" }`. */
    outputs: Record<string, unknown>;
    /** ARM IDs of the resources the deployment created or updated. */
    outputResources: string[];
    /** Provisioning state of the last run (`Succeeded`). */
    provisioningState: string | undefined;
    /** Correlation ID of the last run. */
    correlationId: string | undefined;
    /** Hash of the deployed template. */
    templateHash: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Resource Manager deployment — deploys an ARM template (inline or
 * from a template spec) into a resource group and exposes its outputs.
 *
 * Alchemy re-runs the deployment only when the template, parameters, mode,
 * or tags differ from the last run (or the last run did not succeed).
 * Destroying a `Deployment` deletes the deployment record only; resources
 * the template created stay in the resource group (they are removed with
 * the group). Use `Azure.Resources.DeploymentStack` for managed teardown.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/templates/overview
 *
 * ### Deploying an Inline Template
 * **Example:** Template with a parameter and an output
 * ```typescript
 * const deployment = yield* Azure.Resources.Deployment("greeting", {
 *   resourceGroup: group.resourceGroupName,
 *   template: {
 *     $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
 *     contentVersion: "1.0.0.0",
 *     parameters: { name: { type: "string" } },
 *     resources: [],
 *     outputs: {
 *       greeting: { type: "string", value: "[concat('hello ', parameters('name'))]" },
 *     },
 *   },
 *   parameters: { name: "world" },
 * });
 * // deployment.outputs.greeting === "hello world"
 * ```
 *
 * ### Deploying a Template Spec
 * **Example:** Deploy a template spec version
 * ```typescript
 * yield* Azure.Resources.Deployment("app", {
 *   resourceGroup: group.resourceGroupName,
 *   templateLink: { id: version.templateSpecVersionId },
 * });
 * ```
 *
 * @resource
 */
export const Deployment = Resource<Deployment>("Azure.Resources.Deployment");

export class DeploymentFailed extends Data.TaggedError(
  "Azure.Resources.DeploymentFailed",
)<{
  readonly deployment: string;
  readonly code: string | undefined;
  readonly message: string;
}> {}

const deploymentNameOf = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id });

const getDeployment = (
  subscriptionId: string,
  resourceGroupName: string,
  deploymentName: string,
) =>
  orUndefinedIfNotFound(
    resources.GetDeployment({
      subscriptionId,
      resourceGroupName,
      deploymentName,
    }),
  );

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
  observed: resources.GetDeploymentResponse,
): Deployment["Attributes"] => ({
  deploymentName: name,
  deploymentId:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/deployments/${name}`,
  resourceGroup,
  outputs: fromParameterValues(observed.properties?.outputs),
  outputResources: (observed.properties?.outputResources ?? []).flatMap(
    (resource) => (resource.id === undefined ? [] : [resource.id]),
  ),
  provisioningState: observed.properties?.provisioningState,
  correlationId: observed.properties?.correlationId,
  templateHash: observed.properties?.templateHash,
  tags: userTags(observed.tags),
});

const IN_FLIGHT = new Set([
  "Accepted",
  "Running",
  "Ready",
  "Creating",
  "Created",
  "Updating",
]);

/** Poll until the run settles; a failed run surfaces ARM's error. */
const waitForRun = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
) =>
  waitForProvisioned(
    `deployment ${name}`,
    getDeployment(subscriptionId, resourceGroup, name),
    (deployment) => deployment.properties?.provisioningState,
    { interval: "5 seconds", times: 72 },
  ).pipe(
    Effect.catchTag("Azure.ProvisioningFailed", (failure) =>
      getDeployment(subscriptionId, resourceGroup, name).pipe(
        Effect.flatMap((deployment) => {
          const error = deployment?.properties?.error;
          const details = (error?.details ?? [])
            .map((detail) => `${detail.code}: ${detail.message}`)
            .join("; ");
          return Effect.fail(
            new DeploymentFailed({
              deployment: name,
              code: error?.code,
              message: `deployment ${name} ended in state '${failure.state}': ${error?.message ?? "no error details"}${details ? ` (${details})` : ""}`,
            }),
          );
        }),
      ),
    ),
  );

export const DeploymentProvider = () =>
  Provider.succeed(Deployment, {
    stables: ["deploymentName", "deploymentId", "resourceGroup"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Deployments only list per resource group; Alchemy deploys into
      // Alchemy-owned groups.
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
              .ListDeploymentByResourceGroup({
                subscriptionId,
                resourceGroupName,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListDeploymentByResourceGroup", page),
                ),
              ),
          ).pipe(
            Effect.map((page) =>
              (page?.value ?? []).flatMap((deployment) =>
                deployment.name !== undefined &&
                hasAnyAlchemyTag(deployment.tags)
                  ? [
                      toAttrs(
                        subscriptionId,
                        resourceGroupName,
                        deployment.name,
                        deployment,
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
      if (!isResolved(news.resourceGroup)) return { action: "replace" } as const;
      if (!isResolved(news)) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.deploymentName.toLowerCase())
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
        output?.deploymentName ?? (yield* deploymentNameOf(id, olds?.name));
      const observed = yield* getDeployment(subscriptionId, group, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, group, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Resources");
      const group = news.resourceGroup;
      const name =
        output?.deploymentName ?? (yield* deploymentNameOf(id, news.name));
      const mode = news.mode ?? "Incremental";
      const tags = yield* desiredTags(id, news.tags);

      // Observe. A run still in flight (e.g. from an interrupted deploy)
      // settles first so its result can be compared.
      let observed = yield* getDeployment(subscriptionId, group, name);
      if (IN_FLIGHT.has(observed?.properties?.provisioningState ?? "")) {
        observed = yield* waitForRun(subscriptionId, group, name).pipe(
          Effect.catchTag("Azure.Resources.DeploymentFailed", () =>
            getDeployment(subscriptionId, group, name),
          ),
        );
      }

      // Each PUT is a new run, so only run when the observed last run
      // differs from the desired template, parameters, mode or tags.
      const current = observed?.properties;
      let templateMatches = true;
      if (news.template !== undefined && observed !== undefined) {
        const exported = yield* orUndefinedIfNotFound(
          resources.ExportDeploymentTemplate({
            subscriptionId,
            resourceGroupName: group,
            deploymentName: name,
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
      if (
        observed === undefined ||
        current?.provisioningState !== "Succeeded" ||
        !templateMatches ||
        (current.mode ?? "Incremental") !== mode ||
        !sameJson(
          fromParameterValues(current.parameters),
          news.parameters ?? {},
        ) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* resources.DeploymentsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group,
          deploymentName: name,
          properties: {
            mode,
            template: news.template,
            templateLink: news.templateLink,
            parameters: toParameterValues(news.parameters),
          },
          tags,
        });
      }

      const fresh = yield* waitForRun(subscriptionId, group, name);
      return toAttrs(subscriptionId, group, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resources.DeleteDeployment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          deploymentName: output.deploymentName,
        }),
      );
      yield* waitUntilGone(
        `deployment ${output.deploymentName}`,
        getDeployment(
          subscriptionId,
          output.resourceGroup,
          output.deploymentName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
