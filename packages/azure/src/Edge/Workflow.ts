import * as edge from "@distilled.cloud/azure/edge";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { EDGE_WAIT, edgeState } from "./EdgeShared.ts";

export interface WorkflowProps {
  /**
   * Resource group of the context. Changing it replaces the workflow.
   * @default the stack's resource group
   */
  resourceGroup: string;
  /** Name of the parent context. Changing it replaces the workflow. */
  context: string;
  /**
   * Name of the workflow: 3-61 letters, digits, `-`, and `.`, not starting
   * with `v-`. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the workflow.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
}

export interface Workflow extends Resource<
  "Azure.Edge.Workflow",
  WorkflowProps,
  {
    /** Name of the workflow. */
    workflowName: string;
    /** Name of the parent context. */
    context: string;
    /** Resource group of the context. */
    resourceGroup: string;
    /** ARM resource ID of the workflow. */
    workflowId: string;
    /** Workflow template the service bound the workflow to, if any. */
    workflowTemplateId: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc workload orchestration workflow
 * (`Microsoft.Edge/contexts/workflows`): a named container in a context
 * for the `Azure.Edge.WorkflowVersion` stage definitions that solution
 * deployments run through. See the
 * [workload orchestration overview](https://learn.microsoft.com/azure/azure-arc/workload-orchestration/overview).
 *
 * Workflows carry no tags or settable fields, so Alchemy cannot mark them;
 * one found under the expected name is treated as this resource.
 *
 * :::caution
 * Changing `name`, `context`, or `resourceGroup` replaces the workflow and
 * deletes its versions.
 * :::
 *
 * ### Creating a Workflow
 * **Example:** Workflow in the context
 * ```typescript
 * const context = yield* Azure.Edge.Context("context", {
 *   capabilities: [{ name: "soap", description: "Soap production" }],
 *   hierarchies: [{ name: "factory", description: "Factory" }],
 * });
 * const workflow = yield* Azure.Edge.Workflow("rollout", {
 *   context: context.contextName,
 * });
 * ```
 *
 * @resource
 */
export const Workflow = GroupedResource<Workflow>("Azure.Edge.Workflow");

const getWorkflow = (
  subscriptionId: string,
  resourceGroupName: string,
  contextName: string,
  workflowName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetWorkflow({ subscriptionId, resourceGroupName, contextName, workflowName }),
  );

const toAttrs = (
  resourceGroup: string,
  context: string,
  name: string,
  observed: edge.GetWorkflowResponse,
): Workflow["Attributes"] => ({
  workflowName: name,
  context,
  resourceGroup,
  workflowId: observed.id ?? "",
  workflowTemplateId: observed.properties?.workflowTemplateId,
});

const workflowName = (id: string) =>
  createPhysicalName({ id, maxLength: 61, lowercase: true, forbiddenPrefixes: ["v-"] });

export const WorkflowProvider = () =>
  Provider.succeed(Workflow, {
    stables: ["workflowName", "context", "resourceGroup", "workflowId"],

    // Workflows vanish with their context.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.context.toLowerCase() !== output.context.toLowerCase() ||
        (news.name !== undefined && news.name.toLowerCase() !== output.workflowName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const context = output?.context ?? olds?.context;
      if (resourceGroup === undefined || context === undefined) return undefined;
      const name = output?.workflowName ?? olds?.name ?? (yield* workflowName(id));
      const observed = yield* getWorkflow(subscriptionId, resourceGroup, context, name);
      return observed === undefined ? undefined : toAttrs(resourceGroup, context, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceGroup, context } = news;
      const name = news.name ?? output?.workflowName ?? (yield* workflowName(id));
      const get = getWorkflow(subscriptionId, resourceGroup, context, name);

      // Observe.
      const observed = yield* get;

      // Ensure. A workflow has no settable aspect beyond its identity.
      if (observed === undefined) {
        yield* edge.WorkflowsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          contextName: context,
          workflowName: name,
          properties: {},
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge workflow ${context}/${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, context, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteWorkflow({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          contextName: output.context,
          workflowName: output.workflowName,
        }),
      );
      yield* waitUntilGone(
        `edge workflow ${output.context}/${output.workflowName}`,
        getWorkflow(subscriptionId, output.resourceGroup, output.context, output.workflowName),
        EDGE_WAIT,
      );
    }),
  });
