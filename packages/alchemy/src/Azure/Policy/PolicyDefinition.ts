import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  comparableMetadata,
  metadataTags,
  metadataWithMarker,
  sameJson,
  userMetadata,
} from "../Resources/Shared.ts";

/** Definition of one policy parameter (type, allowed values, default). */
export type PolicyParameterDefinition = resources.ParameterDefinitionsValue;

export interface PolicyDefinitionProps {
  /**
   * Name of the policy definition (the last segment of its ID). At most 64
   * characters, without `<>*%&:\?.+/`. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * definition.
   */
  name?: string;
  /**
   * Policy mode: `All` evaluates every resource type, `Indexed` only types
   * that support tags and location. Resource-provider modes such as
   * `Microsoft.KeyVault.Data` are also accepted.
   * @default "All"
   */
  mode?: string;
  /** Display name shown in the portal. */
  displayName?: string;
  /** Description of the policy definition. */
  description?: string;
  /**
   * The policy rule: an `if` condition and a `then` effect, e.g.
   * `{ if: { field: "location", notIn: ["eastus"] }, then: { effect: "audit" } }`.
   */
  policyRule: Record<string, unknown>;
  /** Parameter definitions referenced from the rule as `[parameters('x')]`. */
  parameters?: Record<string, PolicyParameterDefinition>;
  /**
   * Metadata such as `{ category: "Tags" }`. Alchemy merges ownership
   * entries (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) in because
   * policy definitions have no tags.
   */
  metadata?: Record<string, unknown>;
  /** Semantic version of the definition, e.g. `1.0.0`. */
  version?: string;
}

export interface PolicyDefinition extends Resource<
  "Azure.Policy.PolicyDefinition",
  PolicyDefinitionProps,
  {
    /** Name of the policy definition. */
    policyDefinitionName: string;
    /**
     * ARM ID, `/subscriptions/{id}/providers/Microsoft.Authorization/policyDefinitions/{name}`.
     * Pass it to `PolicyAssignment.policyDefinitionId`.
     */
    policyDefinitionId: string;
    /** Always `Custom` for definitions managed by Alchemy. */
    policyType: string | undefined;
    /** Policy mode. */
    mode: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Current version of the definition. */
    version: string | undefined;
    /** User metadata (ownership and server-stamped entries removed). */
    metadata: Record<string, unknown>;
  },
  never,
  Providers
> {}

/**
 * A custom Azure Policy definition at subscription scope — a rule that
 * audits, denies, or modifies resources. Assign it with
 * `Azure.Policy.PolicyAssignment` to make it take effect.
 *
 * Policy definitions cannot be tagged, so Alchemy records ownership as
 * `alchemy::*` entries in the definition's `metadata`.
 *
 * @see https://learn.microsoft.com/azure/governance/policy/concepts/definition-structure-basics
 *
 * ### Defining a Policy
 * **Example:** Audit resources outside an allowed location
 * ```typescript
 * const definition = yield* Azure.Policy.PolicyDefinition("allowed-locations", {
 *   displayName: "Audit resources outside eastus",
 *   policyRule: {
 *     if: { field: "location", notIn: ["eastus", "global"] },
 *     then: { effect: "audit" },
 *   },
 * });
 * ```
 *
 * **Example:** Parameterised rule
 * ```typescript
 * const definition = yield* Azure.Policy.PolicyDefinition("require-tag", {
 *   mode: "Indexed",
 *   metadata: { category: "Tags" },
 *   parameters: {
 *     tagName: { type: "String", metadata: { displayName: "Tag name" } },
 *   },
 *   policyRule: {
 *     if: { field: "[concat('tags[', parameters('tagName'), ']')]", exists: "false" },
 *     then: { effect: "deny" },
 *   },
 * });
 * ```
 *
 * ### Assigning a Policy
 * **Example:** Assign the definition to a resource group
 * ```typescript
 * yield* Azure.Policy.PolicyAssignment("require-tag", {
 *   scope: group.resourceGroupId,
 *   policyDefinitionId: definition.policyDefinitionId,
 *   parameters: { tagName: "owner" },
 * });
 * ```
 *
 * @resource
 */
export const PolicyDefinition = Resource<PolicyDefinition>(
  "Azure.Policy.PolicyDefinition",
);

const definitionName = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id });

const getDefinition = (subscriptionId: string, policyDefinitionName: string) =>
  orUndefinedIfNotFound(
    resources.GetPolicyDefinition({ subscriptionId, policyDefinitionName }),
  );

const toAttrs = (
  subscriptionId: string,
  name: string,
  observed: resources.GetPolicyDefinitionResponse,
): PolicyDefinition["Attributes"] => ({
  policyDefinitionName: name,
  policyDefinitionId:
    observed.id ??
    `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policyDefinitions/${name}`,
  policyType: observed.properties?.policyType,
  mode: observed.properties?.mode,
  displayName: observed.properties?.displayName,
  version: observed.properties?.version,
  metadata: userMetadata(observed.properties?.metadata),
});

export const PolicyDefinitionProvider = () =>
  Provider.succeed(PolicyDefinition, {
    stables: ["policyDefinitionName", "policyDefinitionId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resources
        .ListPolicyDefinitions({
          subscriptionId,
          _filter: "policyType eq 'Custom'",
        })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPolicyDefinitions", page),
          ),
        );
      return page.value.flatMap((definition) =>
        definition.name !== undefined &&
        hasAnyAlchemyTag(metadataTags(definition.properties?.metadata))
          ? [toAttrs(subscriptionId, definition.name, definition)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.name !== undefined &&
        news.name.toLowerCase() !== output.policyDefinitionName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name =
        output?.policyDefinitionName ?? (yield* definitionName(id, olds?.name));
      const observed = yield* getDefinition(subscriptionId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, name, observed);
      return (yield* isOwned(id, metadataTags(observed.properties?.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Authorization");
      const name =
        output?.policyDefinitionName ?? (yield* definitionName(id, news.name));
      const desired = {
        policyType: "Custom",
        mode: news.mode ?? "All",
        displayName: news.displayName,
        description: news.description,
        policyRule: news.policyRule,
        parameters: news.parameters,
        metadata: yield* metadataWithMarker(id, news.metadata),
        version: news.version,
      };

      // Observe.
      const observed = yield* getDefinition(subscriptionId, name);
      const current = observed?.properties;

      // Ensure + sync. The PUT is an idempotent full write; skip it when
      // every user-controlled field already matches the cloud.
      if (
        current === undefined ||
        current.mode !== desired.mode ||
        current.displayName !== desired.displayName ||
        current.description !== desired.description ||
        !sameJson(current.policyRule, desired.policyRule) ||
        !sameJson(current.parameters ?? {}, desired.parameters ?? {}) ||
        !sameJson(comparableMetadata(current.metadata), desired.metadata) ||
        (desired.version !== undefined && current.version !== desired.version)
      ) {
        yield* resources.PolicyDefinitionsCreateOrUpdate({
          subscriptionId,
          policyDefinitionName: name,
          properties: desired,
        });
      }

      const fresh = yield* waitForProvisioned(
        `policy definition ${name}`,
        getDefinition(subscriptionId, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(subscriptionId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.policyDefinitionName;
      yield* ignoreNotFound(
        resources.DeletePolicyDefinition({
          subscriptionId,
          policyDefinitionName: name,
        }),
      );
      yield* waitUntilGone(
        `policy definition ${name}`,
        getDefinition(subscriptionId, name),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
