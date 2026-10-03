import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
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
import { isWholeExpression, sameMembers, toMembers } from "./Members.ts";
import type { PolicyParameterDefinition } from "./PolicyDefinition.ts";
import type { PolicySetGroup, PolicySetMember } from "./PolicySetDefinition.ts";

export interface PolicySetDefinitionVersionProps {
  /**
   * Name of the parent custom policy set definition, e.g.
   * `set.policySetDefinitionName`. Changing it replaces the version.
   */
  policySetDefinitionName: string;
  /**
   * Semantic version `major.minor.patch`, e.g. `1.0.0`. ARM only accepts
   * versions older than the parent's current `version`. Changing it
   * replaces the version.
   */
  version: string;
  /** Display name of this version. */
  displayName?: string;
  /** Description of this version. */
  description?: string;
  /** The policy definitions this version bundles. */
  policyDefinitions: PolicySetMember[];
  /** Groups that categorise the members. */
  policyDefinitionGroups?: PolicySetGroup[];
  /** Parameter definitions of this version. */
  parameters?: Record<string, PolicyParameterDefinition>;
  /**
   * Metadata of this version. Alchemy merges ownership entries
   * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) in.
   */
  metadata?: Record<string, unknown>;
}

export interface PolicySetDefinitionVersion extends Resource<
  "Azure.Policy.PolicySetDefinitionVersion",
  PolicySetDefinitionVersionProps,
  {
    /** Name of the parent policy set definition. */
    policySetDefinitionName: string;
    /** Semantic version. */
    version: string;
    /** ARM ID, `.../policySetDefinitions/{name}/versions/{version}`. */
    policySetDefinitionVersionId: string;
    /** Display name. */
    displayName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A version of a custom Azure Policy set definition (initiative).
 *
 * Deleting the parent set deletes its versions. Versions are immutable
 * in ARM, so changing any other property deletes and re-publishes the
 * same version.
 *
 * @see https://learn.microsoft.com/azure/governance/policy/concepts/initiative-definition-structure
 *
 * ### Publishing a Version
 * **Example:** Keep version 1.0.0 of an initiative
 * ```typescript
 * const set = yield* Azure.Policy.PolicySetDefinition("baseline", {
 *   version: "2.0.0",
 *   policyDefinitions: [{ policyDefinitionId: definition.policyDefinitionId }],
 * });
 * yield* Azure.Policy.PolicySetDefinitionVersion("baseline-1-0", {
 *   policySetDefinitionName: set.policySetDefinitionName,
 *   version: "1.0.0",
 *   policyDefinitions: [
 *     { policyDefinitionId: definition.policyDefinitionId },
 *     { policyDefinitionId: other.policyDefinitionId },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const PolicySetDefinitionVersion = Resource<PolicySetDefinitionVersion>(
  "Azure.Policy.PolicySetDefinitionVersion",
);

const getVersion = (
  subscriptionId: string,
  policySetDefinitionName: string,
  policyDefinitionVersion: string,
) =>
  orUndefinedIfNotFound(
    resources.GetPolicySetDefinitionVersion({
      subscriptionId,
      policySetDefinitionName,
      policyDefinitionVersion,
    }),
  );

const toAttrs = (
  subscriptionId: string,
  set: string,
  version: string,
  observed: resources.GetPolicySetDefinitionVersionResponse,
): PolicySetDefinitionVersion["Attributes"] => ({
  policySetDefinitionName: set,
  version,
  policySetDefinitionVersionId:
    observed.id ??
    `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policySetDefinitions/${set}/versions/${version}`,
  displayName: observed.properties?.displayName,
});

export const PolicySetDefinitionVersionProvider = () =>
  Provider.succeed(PolicySetDefinitionVersion, {
    stables: [
      "policySetDefinitionName",
      "version",
      "policySetDefinitionVersionId",
    ],

    // Versions are deleted with their parent set.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (isWholeExpression(news)) return undefined;
      if (!isResolved(news.policySetDefinitionName)) {
        return { action: "replace" } as const;
      }
      if (!isResolved<PolicySetDefinitionVersionProps>(news)) return undefined;
      if (
        news.policySetDefinitionName.toLowerCase() !==
          output.policySetDefinitionName.toLowerCase() ||
        news.version !== output.version
      ) {
        return { action: "replace" } as const;
      }
      // ARM versions are immutable: any content change re-publishes the
      // same version number, so the old one must be deleted first.
      if (
        olds !== undefined &&
        (news.displayName !== olds.displayName ||
          news.description !== olds.description ||
          !sameJson(news.policyDefinitions, olds.policyDefinitions) ||
          !sameJson(
            news.policyDefinitionGroups ?? [],
            olds.policyDefinitionGroups ?? [],
          ) ||
          !sameJson(news.parameters ?? {}, olds.parameters ?? {}) ||
          !sameJson(news.metadata ?? {}, olds.metadata ?? {}))
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const set =
        output?.policySetDefinitionName ?? olds?.policySetDefinitionName;
      const version = output?.version ?? olds?.version;
      if (set === undefined || version === undefined) return undefined;
      const observed = yield* getVersion(subscriptionId, set, version);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, set, version, observed);
      return (yield* isOwned(id, metadataTags(observed.properties?.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Authorization");
      const set = news.policySetDefinitionName;
      const version = news.version;
      const metadata = yield* metadataWithMarker(id, news.metadata);

      // Observe.
      const observed = yield* getVersion(subscriptionId, set, version);
      const current = observed?.properties;

      const drifted =
        current !== undefined &&
        (current.displayName !== news.displayName ||
          current.description !== news.description ||
          !sameMembers(
            current.policyDefinitions ?? [],
            news.policyDefinitions,
          ) ||
          !sameJson(
            current.policyDefinitionGroups ?? [],
            news.policyDefinitionGroups ?? [],
          ) ||
          !sameJson(current.parameters ?? {}, news.parameters ?? {}) ||
          !sameJson(comparableMetadata(current.metadata), metadata));

      // Versions are immutable ("Old versions cannot be changed"): a drifted
      // version is deleted and re-published.
      if (drifted) {
        yield* ignoreNotFound(
          resources.DeletePolicySetDefinitionVersion({
            subscriptionId,
            policySetDefinitionName: set,
            policyDefinitionVersion: version,
          }),
        );
        yield* waitUntilGone(
          `policy set definition version ${set}/${version}`,
          getVersion(subscriptionId, set, version),
        );
      }

      // Ensure.
      if (current === undefined || drifted) {
        yield* resources.PolicySetDefinitionVersionsCreateOrUpdate({
          subscriptionId,
          policySetDefinitionName: set,
          policyDefinitionVersion: version,
          properties: {
            policyType: "Custom",
            displayName: news.displayName,
            description: news.description,
            policyDefinitions: toMembers(news.policyDefinitions),
            policyDefinitionGroups: news.policyDefinitionGroups,
            parameters: news.parameters,
            metadata,
            version,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `policy set definition version ${set}/${version}`,
        getVersion(subscriptionId, set, version),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(subscriptionId, set, version, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resources.DeletePolicySetDefinitionVersion({
          subscriptionId,
          policySetDefinitionName: output.policySetDefinitionName,
          policyDefinitionVersion: output.version,
        }),
      );
      yield* waitUntilGone(
        `policy set definition version ${output.policySetDefinitionName}/${output.version}`,
        getVersion(
          subscriptionId,
          output.policySetDefinitionName,
          output.version,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Policy.PolicySetDefinition",
        "Azure.Policy.PolicyDefinition",
      ],
    },
  });
