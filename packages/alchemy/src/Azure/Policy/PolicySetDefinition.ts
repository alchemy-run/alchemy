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
} from "../Resources/Shared.ts";
import type { PolicyParameterDefinition } from "./PolicyDefinition.ts";
import { sameMembers, toMembers } from "./Members.ts";

/** One policy definition included in a policy set (initiative). */
export interface PolicySetMember {
  /**
   * ID of the member definition — a custom
   * `PolicyDefinition.policyDefinitionId` or a built-in
   * `/providers/Microsoft.Authorization/policyDefinitions/{guid}`.
   */
  policyDefinitionId: string;
  /**
   * Unique ID of this member within the set, used by
   * `nonComplianceMessages` and overrides. Required when one definition is
   * included more than once.
   */
  policyDefinitionReferenceId?: string;
  /**
   * Parameter values passed to the member definition, e.g.
   * `{ tagName: "[parameters('tagName')]" }` to forward a set parameter.
   */
  parameters?: Record<string, unknown>;
  /** Names of `policyDefinitionGroups` this member belongs to. */
  groupNames?: string[];
  /** Version of the member definition to use, e.g. `1.*.*`. */
  definitionVersion?: string;
}

/** A group used to categorise members of a policy set. */
export interface PolicySetGroup {
  /** Group name referenced from `PolicySetMember.groupNames`. */
  name: string;
  /** Display name of the group. */
  displayName?: string;
  /** Category of the group. */
  category?: string;
  /** Description of the group. */
  description?: string;
}

export interface PolicySetDefinitionProps {
  /**
   * Name of the policy set definition. At most 64 characters, without
   * `<>*%&:\?.+/`. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the set.
   */
  name?: string;
  /** Display name shown in the portal. */
  displayName?: string;
  /** Description of the policy set. */
  description?: string;
  /** The policy definitions the set bundles. */
  policyDefinitions: PolicySetMember[];
  /** Groups that categorise the members. */
  policyDefinitionGroups?: PolicySetGroup[];
  /** Parameter definitions of the set, forwarded to members. */
  parameters?: Record<string, PolicyParameterDefinition>;
  /**
   * Metadata such as `{ category: "Tags" }`. Alchemy merges ownership
   * entries (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) in because
   * policy sets have no tags.
   */
  metadata?: Record<string, unknown>;
  /** Semantic version of the set, e.g. `1.0.0`. */
  version?: string;
}

export interface PolicySetDefinition extends Resource<
  "Azure.Policy.PolicySetDefinition",
  PolicySetDefinitionProps,
  {
    /** Name of the policy set definition. */
    policySetDefinitionName: string;
    /**
     * ARM ID, `/subscriptions/{id}/providers/Microsoft.Authorization/policySetDefinitions/{name}`.
     * Pass it to `PolicyAssignment.policyDefinitionId`.
     */
    policySetDefinitionId: string;
    /** Always `Custom` for sets managed by Alchemy. */
    policyType: string | undefined;
    /** Display name. */
    displayName: string | undefined;
    /** Current version of the set. */
    version: string | undefined;
    /** IDs of the member policy definitions. */
    policyDefinitionIds: string[];
  },
  never,
  Providers
> {}

/**
 * A custom Azure Policy set definition (initiative) at subscription scope —
 * bundles several policy definitions so they can be assigned together.
 *
 * Policy sets cannot be tagged, so Alchemy records ownership as
 * `alchemy::*` entries in the set's `metadata`.
 *
 * @see https://learn.microsoft.com/azure/governance/policy/concepts/initiative-definition-structure
 *
 * ### Defining an Initiative
 * **Example:** Bundle a custom and a built-in definition
 * ```typescript
 * const set = yield* Azure.Policy.PolicySetDefinition("baseline", {
 *   displayName: "Baseline",
 *   policyDefinitions: [
 *     { policyDefinitionId: definition.policyDefinitionId },
 *     {
 *       // Built-in "Allowed locations"
 *       policyDefinitionId:
 *         "/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c",
 *       parameters: { listOfAllowedLocations: ["eastus"] },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Assigning an Initiative
 * **Example:** Assign the set to a resource group
 * ```typescript
 * yield* Azure.Policy.PolicyAssignment("baseline", {
 *   scope: group.resourceGroupId,
 *   policyDefinitionId: set.policySetDefinitionId,
 * });
 * ```
 *
 * @resource
 */
export const PolicySetDefinition = Resource<PolicySetDefinition>(
  "Azure.Policy.PolicySetDefinition",
);

const setName = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id });

const getSet = (subscriptionId: string, policySetDefinitionName: string) =>
  orUndefinedIfNotFound(
    resources.GetPolicySetDefinition({
      subscriptionId,
      policySetDefinitionName,
    }),
  );

const toAttrs = (
  subscriptionId: string,
  name: string,
  observed: resources.GetPolicySetDefinitionResponse,
): PolicySetDefinition["Attributes"] => ({
  policySetDefinitionName: name,
  policySetDefinitionId:
    observed.id ??
    `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policySetDefinitions/${name}`,
  policyType: observed.properties?.policyType,
  displayName: observed.properties?.displayName,
  version: observed.properties?.version,
  policyDefinitionIds: (observed.properties?.policyDefinitions ?? []).map(
    (member) => member.policyDefinitionId,
  ),
});

export const PolicySetDefinitionProvider = () =>
  Provider.succeed(PolicySetDefinition, {
    stables: ["policySetDefinitionName", "policySetDefinitionId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resources
        .ListPolicySetDefinitions({
          subscriptionId,
          _filter: "policyType eq 'Custom'",
        })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPolicySetDefinitions", page),
          ),
        );
      return (page.value ?? []).flatMap((set) =>
        set.name !== undefined &&
        hasAnyAlchemyTag(metadataTags(set.properties?.metadata))
          ? [toAttrs(subscriptionId, set.name, set)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.name !== undefined &&
        news.name.toLowerCase() !== output.policySetDefinitionName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name =
        output?.policySetDefinitionName ?? (yield* setName(id, olds?.name));
      const observed = yield* getSet(subscriptionId, name);
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
        output?.policySetDefinitionName ?? (yield* setName(id, news.name));
      const metadata = yield* metadataWithMarker(id, news.metadata);

      // Observe.
      const observed = yield* getSet(subscriptionId, name);
      const current = observed?.properties;

      // Ensure + sync with one idempotent full PUT, skipped when the
      // observed set already matches.
      if (
        current === undefined ||
        current.displayName !== news.displayName ||
        current.description !== news.description ||
        !sameMembers(current.policyDefinitions ?? [], news.policyDefinitions) ||
        !sameJson(
          current.policyDefinitionGroups ?? [],
          news.policyDefinitionGroups ?? [],
        ) ||
        !sameJson(current.parameters ?? {}, news.parameters ?? {}) ||
        !sameJson(comparableMetadata(current.metadata), metadata) ||
        (news.version !== undefined && current.version !== news.version)
      ) {
        yield* resources.PolicySetDefinitionsCreateOrUpdate({
          subscriptionId,
          policySetDefinitionName: name,
          properties: {
            policyType: "Custom",
            displayName: news.displayName,
            description: news.description,
            policyDefinitions: toMembers(news.policyDefinitions),
            policyDefinitionGroups: news.policyDefinitionGroups,
            parameters: news.parameters,
            metadata,
            version: news.version,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `policy set definition ${name}`,
        getSet(subscriptionId, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(subscriptionId, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.policySetDefinitionName;
      yield* ignoreNotFound(
        resources.DeletePolicySetDefinition({
          subscriptionId,
          policySetDefinitionName: name,
        }),
      );
      yield* waitUntilGone(
        `policy set definition ${name}`,
        getSet(subscriptionId, name),
      );
    }),

    nuke: {
      // Members must outlive the set that references them.
      dependsOn: [
        "Azure.Policy.PolicyDefinition",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
