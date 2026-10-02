import * as edge from "@distilled.cloud/azure/edge";
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
import { EDGE_WAIT, edgeState, sameJson } from "./EdgeShared.ts";

export interface SolutionTemplateProps {
  /** Resource group the solution template is created in. Changing it replaces the solution template. */
  resourceGroup: string;
  /**
   * Name of the solution template. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the solution template.
   */
  name?: string;
  /**
   * Azure location of the solution template. Workload orchestration is available in
   * `eastus` and `eastus2`. Changing it replaces the solution template.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the solution template. */
  description: string;
  /**
   * Capabilities the solution needs from a target. Each must be declared
   * on the subscription's context.
   */
  capabilities: string[];
  /**
   * Whether the template can be deployed.
   * @default "active"
   */
  state?: "active" | "inactive";
  /**
   * Whether solution versions go through external validation before they
   * can be deployed.
   * @default false
   */
  enableExternalValidation?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface SolutionTemplate extends Resource<
  "Azure.Edge.SolutionTemplate",
  SolutionTemplateProps,
  {
    /** Name of the solution template. */
    solutionTemplateName: string;
    /** Resource group that holds the solution template. */
    resourceGroup: string;
    /** ARM resource ID of the solution template. */
    solutionTemplateId: string;
    /** Location of the solution template. */
    location: string;
    /** Description of the solution template. */
    description: string;
    /** System-generated unique identifier of the solution template. */
    uniqueIdentifier: string | undefined;
    /** Latest version of the solution template, if any. */
    latestVersion: string | undefined;
    /** Capabilities the solution needs from a target. */
    capabilities: string[];
    /** Whether the template can be deployed. */
    state: string | undefined;
    /** Whether external validation is enabled. */
    enableExternalValidation: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc workload orchestration solution template. A solution
 * template describes an application (Helm chart plus configuration
 * schema) that can be deployed to targets offering the template's
 * capabilities. Every capability must be declared on the subscription's
 * `Azure.Edge.Context`. The chart and YAML live in immutable
 * `Azure.Edge.SolutionTemplateVersion` children.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/overview
 *
 * ### Creating a Solution Template
 * **Example:** Solution template for a context capability
 * ```typescript
 * const context = yield* Azure.Edge.Context("context", {
 *   resourceGroup: group.resourceGroupName,
 *   capabilities: [{ name: "soap", description: "Soap production" }],
 *   hierarchies: [{ name: "country", description: "Country" }],
 * });
 * const app = yield* Azure.Edge.SolutionTemplate("app", {
 *   resourceGroup: group.resourceGroupName,
 *   description: "Price detector",
 *   capabilities: [context.capabilities[0]!.name],
 * });
 * ```
 *
 * **Example:** Inactive template
 * ```typescript
 * const app = yield* Azure.Edge.SolutionTemplate("app", {
 *   resourceGroup: group.resourceGroupName,
 *   description: "Price detector",
 *   capabilities: ["soap"],
 *   state: "inactive",
 * });
 * ```
 *
 * @resource
 */
export const SolutionTemplate = Resource<SolutionTemplate>("Azure.Edge.SolutionTemplate");

const getSolutionTemplate = (
  subscriptionId: string,
  resourceGroupName: string,
  solutionTemplateName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetSolutionTemplate({ subscriptionId, resourceGroupName, solutionTemplateName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  solutionTemplate: edge.GetSolutionTemplateResponse,
): SolutionTemplate["Attributes"] => ({
  solutionTemplateName: name,
  resourceGroup,
  solutionTemplateId: solutionTemplate.id ?? "",
  location: solutionTemplate.location,
  description: solutionTemplate.properties?.description ?? "",
  uniqueIdentifier: solutionTemplate.properties?.uniqueIdentifier,
  latestVersion: solutionTemplate.properties?.latestVersion,
  capabilities: [...(solutionTemplate.properties?.capabilities ?? [])],
  state: solutionTemplate.properties?.state,
  enableExternalValidation:
    solutionTemplate.properties?.enableExternalValidation ?? false,
  tags: userTags(solutionTemplate.tags),
});

const solutionTemplateName = (id: string) => createPhysicalName({ id, maxLength: 63 });

export const SolutionTemplateProvider = () =>
  Provider.succeed(SolutionTemplate, {
    stables: ["solutionTemplateName", "resourceGroup", "solutionTemplateId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListSolutionTemplateBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSolutionTemplateBySubscription", page),
          ),
        );
      return page.value.flatMap((solutionTemplate) => {
        const group = resourceGroupOf(solutionTemplate.id);
        return hasAnyAlchemyTag(solutionTemplate.tags) &&
          group !== undefined &&
          solutionTemplate.name !== undefined
          ? [toAttrs(group, solutionTemplate.name, solutionTemplate)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.solutionTemplateName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.solutionTemplateName ?? olds?.name ?? (yield* solutionTemplateName(id));
      const observed = yield* getSolutionTemplate(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.solutionTemplateName ?? (yield* solutionTemplateName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getSolutionTemplate(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      const desired = {
        description: news.description,
        capabilities: news.capabilities,
        state: news.state ?? "active",
        enableExternalValidation: news.enableExternalValidation ?? false,
      };

      // Ensure.
      if (observed === undefined) {
        yield* edge.SolutionTemplatesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          solutionTemplateName: name,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: desired,
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const props = observed.properties;
        const delta: edge.SolutionTemplateUpdateProperties = {
          ...(props?.description !== desired.description
            ? { description: desired.description }
            : {}),
          ...(!sameJson(props?.capabilities, desired.capabilities)
            ? { capabilities: desired.capabilities }
            : {}),
          ...((props?.state ?? "active") !== desired.state
            ? { state: desired.state }
            : {}),
          ...((props?.enableExternalValidation ?? false) !==
          desired.enableExternalValidation
            ? { enableExternalValidation: desired.enableExternalValidation }
            : {}),
        };
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (tagsChanged || Object.keys(delta).length > 0) {
          yield* edge.UpdateSolutionTemplate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            solutionTemplateName: name,
            ...(tagsChanged ? { tags } : {}),
            properties: delta,
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `edge solution template ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteSolutionTemplate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          solutionTemplateName: output.solutionTemplateName,
        }),
      );
      yield* waitUntilGone(
        `edge solution template ${output.solutionTemplateName}`,
        getSolutionTemplate(subscriptionId, output.resourceGroup, output.solutionTemplateName),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
