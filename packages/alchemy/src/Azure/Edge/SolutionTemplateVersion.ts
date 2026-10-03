import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { EDGE_WAIT, edgeState, sameJson } from "./EdgeShared.ts";

export interface SolutionTemplateVersionProps {
  /** Resource group of the solution template. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the parent solution template. Changing it replaces the version. */
  solutionTemplate: string;
  /**
   * Semantic version, e.g. `1.0.0`. Versions are immutable; changing it
   * creates a new version and deletes the old one.
   */
  version: string;
  /**
   * Configuration template YAML: an optional inline `schema:` plus
   * `configs:`. Versions are immutable; changing it replaces the version.
   */
  configurations: string;
  /**
   * Deployment specification: the Helm chart and artifacts, e.g.
   * `{ components: [{ name, type: "helm.v3", properties: { chart: { repo, version } } }] }`.
   * Changing it replaces the version.
   */
  specification: Record<string, unknown>;
  /**
   * Orchestrator that deploys the solution. Changing it replaces the
   * version.
   * @default "TO"
   */
  orchestratorType?: "TO";
}

export interface SolutionTemplateVersion extends Resource<
  "Azure.Edge.SolutionTemplateVersion",
  SolutionTemplateVersionProps,
  {
    /** Version name. */
    version: string;
    /** Name of the parent solution template. */
    solutionTemplate: string;
    /** Resource group of the solution template. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    solutionTemplateVersionId: string;
    /** Configuration template YAML. */
    configurations: string;
    /** Deployment specification (Helm chart and artifacts). */
    specification: Record<string, unknown>;
    /** Orchestrator that deploys the solution. */
    orchestratorType: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An immutable version of an Azure Arc workload orchestration solution
 * template: the configuration template YAML plus the Helm deployment
 * specification. Reviewing, publishing, and installing a version on a
 * target are actions, not resources.
 *
 * Versions carry no tags or free-form fields, so Alchemy cannot mark them;
 * a version found under the expected name is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/overview
 *
 * ### Publishing a Version
 * **Example:** Helm solution version
 * ```typescript
 * yield* Azure.Edge.SolutionTemplateVersion("app-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   solutionTemplate: app.solutionTemplateName,
 *   version: "1.0.0",
 *   configurations: [
 *     "schema:",
 *     "  rules:",
 *     "    configs:",
 *     "      ErrorThreshold:",
 *     "        type: float",
 *     "        required: true",
 *     "        editableBy:",
 *     "          - OT",
 *     "configs:",
 *     "  ErrorThreshold: ${{$val(ErrorThreshold)}}",
 *   ].join("\n"),
 *   specification: {
 *     components: [
 *       {
 *         name: "price-detector",
 *         type: "helm.v3",
 *         properties: {
 *           chart: { repo: "contoso.azurecr.io/helm/app", version: "1.0.0" },
 *         },
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const SolutionTemplateVersion = Resource<SolutionTemplateVersion>(
  "Azure.Edge.SolutionTemplateVersion",
);

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  solutionTemplateName: string,
  solutionTemplateVersionName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetSolutionTemplateVersion({
      subscriptionId,
      resourceGroupName,
      solutionTemplateName,
      solutionTemplateVersionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  solutionTemplate: string,
  version: string,
  observed: edge.GetSolutionTemplateVersionResponse,
): SolutionTemplateVersion["Attributes"] => ({
  version,
  solutionTemplate,
  resourceGroup,
  solutionTemplateVersionId: observed.id ?? "",
  configurations: observed.properties?.configurations ?? "",
  specification: { ...observed.properties?.specification },
  orchestratorType: observed.properties?.orchestratorType,
});

export const SolutionTemplateVersionProvider = () =>
  Provider.succeed(SolutionTemplateVersion, {
    stables: [
      "version",
      "solutionTemplate",
      "resourceGroup",
      "solutionTemplateVersionId",
    ],

    // Versions vanish with their solution template.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const moved =
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.solutionTemplate.toLowerCase() !==
          output.solutionTemplate.toLowerCase() ||
        news.version !== output.version;
      if (
        moved ||
        news.configurations !== output.configurations ||
        !sameJson(news.specification, output.specification) ||
        (news.orchestratorType ?? "TO") !== (output.orchestratorType ?? "TO")
      ) {
        // Same name, new payload: the old version must go first.
        return { action: "replace", deleteFirst: !moved } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const solutionTemplate =
        output?.solutionTemplate ?? olds?.solutionTemplate;
      const version = output?.version ?? olds?.version;
      if (
        resourceGroup === undefined ||
        solutionTemplate === undefined ||
        version === undefined
      ) {
        return undefined;
      }
      const observed = yield* getVersion(
        subscriptionId,
        resourceGroup,
        solutionTemplate,
        version,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, solutionTemplate, version, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceGroup, solutionTemplate, version } = news;
      const get = getVersion(
        subscriptionId,
        resourceGroup,
        solutionTemplate,
        version,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. The payload is the version's only aspect.
      if (
        observed === undefined ||
        observed.properties?.configurations !== news.configurations ||
        !sameJson(observed.properties?.specification, news.specification)
      ) {
        yield* edge.SolutionTemplateVersionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          solutionTemplateName: solutionTemplate,
          solutionTemplateVersionName: version,
          properties: {
            configurations: news.configurations,
            specification: news.specification,
            orchestratorType: news.orchestratorType ?? "TO",
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge solution template version ${solutionTemplate}/${version}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, solutionTemplate, version, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteSolutionTemplateVersion({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          solutionTemplateName: output.solutionTemplate,
          solutionTemplateVersionName: output.version,
        }),
      );
      yield* waitUntilGone(
        `edge solution template version ${output.solutionTemplate}/${output.version}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.solutionTemplate,
          output.version,
        ),
        EDGE_WAIT,
      );
    }),
  });
