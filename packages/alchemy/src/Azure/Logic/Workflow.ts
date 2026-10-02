import * as logic from "@distilled.cloud/azure/logic";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLogicName,
  HASH_KEY,
  hashOf,
  propertiesDiffer,
} from "./LogicShared.ts";

/** A workflow parameter value. */
export interface WorkflowParameterValue {
  /** Parameter type; must match the declaration in `definition.parameters`. */
  type:
    | "String"
    | "SecureString"
    | "Int"
    | "Float"
    | "Bool"
    | "Array"
    | "Object"
    | "SecureObject";
  /**
   * Parameter value. `SecureString`/`SecureObject` values are write-only:
   * Azure never returns them.
   */
  value: unknown;
}

/** Caller restrictions for one workflow surface. */
export interface WorkflowAccessControlPolicy {
  /** Allowed caller IP ranges, e.g. `[{ addressRange: "10.0.0.0/24" }]`. */
  allowedCallerIpAddresses?: Array<{ addressRange?: string }>;
  /** Microsoft Entra ID (OAuth) authorization policies, keyed by name. */
  openAuthenticationPolicies?: {
    policies?: Record<
      string,
      {
        type?: "AAD";
        claims?: Array<{ name?: string; value?: string }>;
      }
    >;
  };
}

/** Access control for the workflow's triggers, run contents, and actions. */
export interface WorkflowAccessControl {
  /** Who may call request/webhook triggers. */
  triggers?: WorkflowAccessControlPolicy;
  /** Who may read run inputs and outputs. */
  contents?: WorkflowAccessControlPolicy;
  /** Who may call actions. */
  actions?: WorkflowAccessControlPolicy;
  /** Who may manage the workflow. */
  workflowManagement?: WorkflowAccessControlPolicy;
}

/** Managed identity of the workflow. */
export interface WorkflowIdentity {
  /** Identity type. A workflow has either a system- or user-assigned identity. */
  type: "SystemAssigned" | "UserAssigned" | "None";
  /** ARM IDs of user-assigned identities (with `type: "UserAssigned"`). */
  userAssignedIdentities?: string[];
}

export interface WorkflowProps {
  /**
   * Resource group the workflow is created in. Changing it replaces the
   * workflow.
   */
  resourceGroup: string;
  /**
   * Workflow name: 1-80 letters, digits, `-`, `_`, `.`, `(`, `)`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the workflow.
   */
  name?: string;
  /**
   * Azure location of the workflow. Changing it replaces the workflow.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Workflow Definition Language document: `$schema`, `contentVersion`,
   * `parameters`, `triggers`, `actions`, `outputs`.
   * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-workflow-definition-language
   */
  definition: Record<string, unknown>;
  /**
   * Values for parameters declared in `definition.parameters`. Azure
   * rejects values for undeclared parameters.
   */
  parameters?: Record<string, WorkflowParameterValue>;
  /**
   * Whether triggers fire. A disabled workflow rejects calls to its
   * request trigger.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
  /** Caller restrictions (IP ranges, Entra ID policies). */
  accessControl?: WorkflowAccessControl;
  /**
   * ARM ID of an integration account (same location) whose B2B artifacts
   * the workflow uses.
   */
  integrationAccount?: string;
  /** Managed identity used by HTTP actions and managed connectors. */
  identity?: WorkflowIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`, and a configuration hash) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Workflow extends Resource<
  "Azure.Logic.Workflow",
  WorkflowProps,
  {
    /** Name of the workflow. */
    workflowName: string;
    /** Resource group that holds the workflow. */
    resourceGroup: string;
    /** ARM resource ID of the workflow. */
    workflowId: string;
    /** Location of the workflow. */
    location: string;
    /** `Enabled` or `Disabled`. */
    state: string;
    /** Version ID of the current definition. */
    version: string | undefined;
    /** Workflow access endpoint. */
    accessEndpoint: string | undefined;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /**
     * Callback URLs of the definition's `Request` triggers, keyed by
     * trigger name. They embed a SAS signature, so they are redacted.
     */
    triggerCallbackUrls: Record<string, Redacted.Redacted<string>>;
    /** User tags (Alchemy tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Consumption (multi-tenant) Azure Logic Apps workflow. Billed per
 * action execution, so an idle workflow costs nothing.
 *
 * Standard (single-tenant) Logic Apps run on App Service; see
 * `Azure.Web.WebApp`.
 *
 * @see https://learn.microsoft.com/azure/logic-apps/logic-apps-overview
 *
 * ### Creating a Workflow
 * **Example:** HTTP request/response workflow
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const hello = yield* Azure.Logic.Workflow("hello", {
 *   resourceGroup: group.resourceGroupName,
 *   definition: {
 *     $schema:
 *       "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
 *     contentVersion: "1.0.0.0",
 *     triggers: {
 *       manual: { type: "Request", kind: "Http", inputs: { schema: {} } },
 *     },
 *     actions: {
 *       reply: {
 *         type: "Response",
 *         kind: "Http",
 *         inputs: { statusCode: 200, body: "hello" },
 *       },
 *     },
 *   },
 * });
 * // POST to Redacted.value(hello.triggerCallbackUrls.manual)
 * ```
 *
 * **Example:** Scheduled workflow with parameters
 * ```typescript
 * const nightly = yield* Azure.Logic.Workflow("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   definition: {
 *     $schema:
 *       "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
 *     contentVersion: "1.0.0.0",
 *     parameters: { target: { type: "String" } },
 *     triggers: {
 *       daily: { type: "Recurrence", recurrence: { frequency: "Day", interval: 1 } },
 *     },
 *     actions: {
 *       ping: {
 *         type: "Http",
 *         inputs: { method: "GET", uri: "@parameters('target')" },
 *       },
 *     },
 *   },
 *   parameters: { target: { type: "String", value: "https://example.com" } },
 * });
 * ```
 *
 * ### Securing a Workflow
 * **Example:** Restrict trigger callers and use a managed identity
 * ```typescript
 * const secured = yield* Azure.Logic.Workflow("secured", {
 *   resourceGroup: group.resourceGroupName,
 *   definition,
 *   identity: { type: "SystemAssigned" },
 *   accessControl: {
 *     triggers: { allowedCallerIpAddresses: [{ addressRange: "203.0.113.0/24" }] },
 *   },
 * });
 * ```
 *
 * **Example:** Disable a workflow
 * ```typescript
 * yield* Azure.Logic.Workflow("hello", {
 *   resourceGroup: group.resourceGroupName,
 *   definition,
 *   state: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const Workflow = Resource<Workflow>("Azure.Logic.Workflow");

type ObservedWorkflow = logic.GetWorkflowResponse;

const getWorkflow = (
  subscriptionId: string,
  resourceGroupName: string,
  workflowName: string,
) =>
  orUndefinedIfNotFound(
    logic.GetWorkflow({ subscriptionId, resourceGroupName, workflowName }),
  );

const SECURE_TYPES = new Set(["securestring", "secureobject"]);

/** Desired parameters as Azure echoes them (secure values are never returned). */
const comparableParameters = (
  parameters: Record<string, WorkflowParameterValue> | undefined,
) =>
  parameters === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(parameters).map(([key, p]) => [
          key,
          SECURE_TYPES.has(p.type.toLowerCase()) ? { type: p.type } : p,
        ]),
      );

const requestTriggers = (definition: unknown) => {
  const triggers =
    definition !== null && typeof definition === "object"
      ? (definition as { triggers?: unknown }).triggers
      : undefined;
  if (triggers === null || typeof triggers !== "object") return [];
  return Object.entries(triggers as Record<string, unknown>).flatMap(
    ([name, trigger]) =>
      trigger !== null &&
      typeof trigger === "object" &&
      String((trigger as { type?: unknown }).type).toLowerCase() === "request"
        ? [name]
        : [],
  );
};

const identityDiffers = (
  desired: WorkflowIdentity | undefined,
  observed: ObservedWorkflow["identity"],
) => {
  const want = desired?.type ?? "None";
  const have = observed?.type ?? "None";
  if (want !== have) return true;
  const wantIds = (desired?.userAssignedIdentities ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  const haveIds = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return wantIds.join("\n") !== haveIds.join("\n");
};

const toAttrs = (
  resourceGroup: string,
  name: string,
  workflow: ObservedWorkflow,
  triggerCallbackUrls: Record<string, Redacted.Redacted<string>>,
): Workflow["Attributes"] => ({
  workflowName: name,
  resourceGroup,
  workflowId: workflow.id ?? "",
  location: workflow.location ?? "",
  state: workflow.properties?.state ?? "",
  version: workflow.properties?.version,
  accessEndpoint: workflow.properties?.accessEndpoint,
  principalId: workflow.identity?.principalId,
  triggerCallbackUrls,
  tags: userTags(workflow.tags),
});

const callbackUrls = (
  subscriptionId: string,
  resourceGroupName: string,
  workflowName: string,
  definition: unknown,
) =>
  Effect.forEach(requestTriggers(definition), (triggerName) =>
    logic
      .ListWorkflowTriggerCallbackUrl({
        subscriptionId,
        resourceGroupName,
        workflowName,
        triggerName,
      })
      .pipe(
        Effect.map((url) =>
          url.value === undefined
            ? []
            : [[triggerName, Redacted.make(url.value)] as const],
        ),
      ),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries.flat())));

export const WorkflowProvider = () =>
  Provider.succeed(Workflow, {
    stables: ["workflowName", "resourceGroup", "workflowId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* logic
        .ListWorkflowBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListWorkflowBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((workflow) => {
        const group = resourceGroupOf(workflow.id);
        return hasAnyAlchemyTag(workflow.tags) &&
          group !== undefined &&
          workflow.name !== undefined
          ? [toAttrs(group, workflow.name, workflow, {})]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.workflowName.toLowerCase()) ||
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
      const name =
        output?.workflowName ?? olds?.name ?? (yield* createLogicName(id));
      const observed = yield* getWorkflow(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        name,
        observed,
        output?.triggerCallbackUrls ?? {},
      );
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Logic");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.workflowName ?? (yield* createLogicName(id));
      const location = news.location ?? output?.location ?? env.location;
      const state = news.state ?? "Enabled";
      const properties = {
        definition: news.definition,
        parameters: news.parameters,
        state,
        accessControl: news.accessControl,
        integrationAccount:
          news.integrationAccount === undefined
            ? undefined
            : { id: news.integrationAccount },
      };
      const identity =
        news.identity === undefined
          ? undefined
          : {
              type: news.identity.type,
              userAssignedIdentities: news.identity.userAssignedIdentities
                ? Object.fromEntries(
                    news.identity.userAssignedIdentities.map((id) => [id, {}]),
                  )
                : undefined,
            };
      const tags = yield* desiredTags(id, {
        ...news.tags,
        [HASH_KEY]: yield* hashOf({ properties, identity }),
      });

      // Observe.
      let observed = yield* getWorkflow(subscriptionId, resourceGroup, name);

      // Ensure + sync. The PUT replaces the whole workflow synchronously,
      // so any observed delta (or a hash change for fields Azure does not
      // echo faithfully) is one full PUT.
      const observedIntegrationAccount =
        observed?.properties?.integrationAccount?.id?.toLowerCase();
      if (
        observed === undefined ||
        tagsDiffer(observed.tags, tags) ||
        propertiesDiffer(
          {
            definition: news.definition,
            parameters: comparableParameters(news.parameters),
            state,
            accessControl: news.accessControl,
          },
          observed.properties,
        ) ||
        observedIntegrationAccount !== news.integrationAccount?.toLowerCase() ||
        identityDiffers(news.identity, observed.identity)
      ) {
        observed = yield* logic.WorkflowsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          workflowName: name,
          location: observed?.location ?? location,
          tags,
          properties,
          // Omitting the identity keeps an existing one; remove it explicitly.
          identity:
            identity ??
            (observed?.identity !== undefined &&
            observed.identity.type !== "None"
              ? { type: "None" }
              : undefined),
        });
      }

      const urls = yield* callbackUrls(
        subscriptionId,
        resourceGroup,
        name,
        news.definition,
      );
      return toAttrs(resourceGroup, name, observed, urls);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        logic.DeleteWorkflow({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          workflowName: output.workflowName,
        }),
      );
      yield* waitUntilGone(
        `workflow ${output.workflowName}`,
        getWorkflow(subscriptionId, output.resourceGroup, output.workflowName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
