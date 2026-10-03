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
import { isWholeExpression } from "./Members.ts";
import {
  comparableMetadata,
  metadataTags,
  metadataWithMarker,
  sameJson,
} from "../Resources/Shared.ts";
import type { PolicyParameterDefinition } from "./PolicyDefinition.ts";

export interface PolicyDefinitionVersionProps {
  /**
   * Name of the parent custom policy definition, e.g.
   * `definition.policyDefinitionName`. Changing it replaces the version.
   */
  policyDefinitionName: string;
  /**
   * Semantic version `major.minor.patch`, e.g. `1.0.0`. ARM only accepts
   * versions older than the parent's current `version`. Changing it
   * replaces the version.
   */
  version: string;
  /**
   * Policy mode of this version.
   * @default "All"
   */
  mode?: string;
  /** Display name of this version. */
  displayName?: string;
  /** Description of this version. */
  description?: string;
  /** The policy rule of this version. */
  policyRule: Record<string, unknown>;
  /** Parameter definitions of this version. */
  parameters?: Record<string, PolicyParameterDefinition>;
  /**
   * Metadata of this version. Alchemy merges ownership entries
   * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) in.
   */
  metadata?: Record<string, unknown>;
}

export interface PolicyDefinitionVersion extends Resource<
  "Azure.Policy.PolicyDefinitionVersion",
  PolicyDefinitionVersionProps,
  {
    /** Name of the parent policy definition. */
    policyDefinitionName: string;
    /** Semantic version. */
    version: string;
    /** ARM ID, `.../policyDefinitions/{name}/versions/{version}`. */
    policyDefinitionVersionId: string;
    /** Display name. */
    displayName: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A version of a custom Azure Policy definition. Assignments can pin a
 * version with `PolicyAssignment.definitionVersion` (e.g. `1.*.*`).
 *
 * Deleting the parent definition deletes its versions. Versions are
 * immutable in ARM, so changing any other property deletes and
 * re-publishes the same version.
 *
 * @see https://learn.microsoft.com/azure/governance/policy/concepts/definition-structure-basics#version-preview
 *
 * ### Publishing a Version
 * **Example:** Keep version 1.0.0 of a custom definition
 * ```typescript
 * const definition = yield* Azure.Policy.PolicyDefinition("audit-tag", {
 *   version: "2.0.0",
 *   policyRule: {
 *     if: { field: "tags['owner']", exists: "false" },
 *     then: { effect: "audit" },
 *   },
 * });
 * yield* Azure.Policy.PolicyDefinitionVersion("audit-tag-1-0", {
 *   policyDefinitionName: definition.policyDefinitionName,
 *   version: "1.0.0",
 *   policyRule: {
 *     if: { field: "tags['owner']", exists: "false" },
 *     then: { effect: "deny" },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const PolicyDefinitionVersion = Resource<PolicyDefinitionVersion>(
  "Azure.Policy.PolicyDefinitionVersion",
);

const getVersion = (
  subscriptionId: string,
  policyDefinitionName: string,
  policyDefinitionVersion: string,
) =>
  orUndefinedIfNotFound(
    resources.GetPolicyDefinitionVersion({
      subscriptionId,
      policyDefinitionName,
      policyDefinitionVersion,
    }),
  );

const toAttrs = (
  subscriptionId: string,
  definition: string,
  version: string,
  observed: resources.GetPolicyDefinitionVersionResponse,
): PolicyDefinitionVersion["Attributes"] => ({
  policyDefinitionName: definition,
  version,
  policyDefinitionVersionId:
    observed.id ??
    `/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/policyDefinitions/${definition}/versions/${version}`,
  displayName: observed.properties?.displayName,
});

export const PolicyDefinitionVersionProvider = () =>
  Provider.succeed(PolicyDefinitionVersion, {
    stables: ["policyDefinitionName", "version", "policyDefinitionVersionId"],

    // Versions are deleted with their parent definition.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (isWholeExpression(news)) return undefined;
      if (!isResolved(news.policyDefinitionName)) {
        return { action: "replace" } as const;
      }
      if (!isResolved<PolicyDefinitionVersionProps>(news)) return undefined;
      if (
        news.policyDefinitionName.toLowerCase() !==
          output.policyDefinitionName.toLowerCase() ||
        news.version !== output.version
      ) {
        return { action: "replace" } as const;
      }
      // ARM versions are immutable: any content change re-publishes the
      // same version number, so the old one must be deleted first.
      if (
        olds !== undefined &&
        ((news.mode ?? "All") !== (olds.mode ?? "All") ||
          news.displayName !== olds.displayName ||
          news.description !== olds.description ||
          !sameJson(news.policyRule, olds.policyRule) ||
          !sameJson(news.parameters ?? {}, olds.parameters ?? {}) ||
          !sameJson(news.metadata ?? {}, olds.metadata ?? {}))
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const definition =
        output?.policyDefinitionName ?? olds?.policyDefinitionName;
      const version = output?.version ?? olds?.version;
      if (definition === undefined || version === undefined) return undefined;
      const observed = yield* getVersion(subscriptionId, definition, version);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, definition, version, observed);
      return (yield* isOwned(id, metadataTags(observed.properties?.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Authorization");
      const definition = news.policyDefinitionName;
      const version = news.version;
      const desired = {
        policyType: "Custom",
        mode: news.mode ?? "All",
        displayName: news.displayName,
        description: news.description,
        policyRule: news.policyRule,
        parameters: news.parameters,
        metadata: yield* metadataWithMarker(id, news.metadata),
        version,
      };

      // Observe.
      const observed = yield* getVersion(subscriptionId, definition, version);
      const current = observed?.properties;

      const drifted =
        current !== undefined &&
        (current.mode !== desired.mode ||
          current.displayName !== desired.displayName ||
          current.description !== desired.description ||
          !sameJson(current.policyRule, desired.policyRule) ||
          !sameJson(current.parameters ?? {}, desired.parameters ?? {}) ||
          !sameJson(comparableMetadata(current.metadata), desired.metadata));

      // Versions are immutable ("Old versions cannot be changed"): a drifted
      // version is deleted and re-published.
      if (drifted) {
        yield* ignoreNotFound(
          resources.DeletePolicyDefinitionVersion({
            subscriptionId,
            policyDefinitionName: definition,
            policyDefinitionVersion: version,
          }),
        );
        yield* waitUntilGone(
          `policy definition version ${definition}/${version}`,
          getVersion(subscriptionId, definition, version),
        );
      }

      // Ensure.
      if (current === undefined || drifted) {
        yield* resources.PolicyDefinitionVersionsCreateOrUpdate({
          subscriptionId,
          policyDefinitionName: definition,
          policyDefinitionVersion: version,
          properties: desired,
        });
      }

      const fresh = yield* waitForProvisioned(
        `policy definition version ${definition}/${version}`,
        getVersion(subscriptionId, definition, version),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(subscriptionId, definition, version, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resources.DeletePolicyDefinitionVersion({
          subscriptionId,
          policyDefinitionName: output.policyDefinitionName,
          policyDefinitionVersion: output.version,
        }),
      );
      yield* waitUntilGone(
        `policy definition version ${output.policyDefinitionName}/${output.version}`,
        getVersion(subscriptionId, output.policyDefinitionName, output.version),
      );
    }),

    nuke: { dependsOn: ["Azure.Policy.PolicyDefinition"] },
  });
