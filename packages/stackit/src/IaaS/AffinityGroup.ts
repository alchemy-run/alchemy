import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  IAAS_NAME_MAX_LENGTH,
  iaasName,
  projectScopeChanged,
  resolveProjectScope,
  type ProjectScope,
  type ProjectScopedProps,
} from "./internal.ts";

/** The create response of an affinity group carried no id. */
export class AffinityGroupIdMissing extends Data.TaggedError(
  "Stackit.IaaS.AffinityGroupIdMissing",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/** Placement policy of an affinity group. */
export type AffinityGroupPolicy =
  | "hard-affinity"
  | "soft-affinity"
  | "hard-anti-affinity"
  | "soft-anti-affinity";

export interface AffinityGroupProps extends ProjectScopedProps {
  /**
   * Name of the affinity group. Changing it replaces the group.
   * @default a physical name generated from the app, stage and logical id
   */
  name?: string;
  /**
   * Placement policy. `hard-*` policies fail a server create that cannot be
   * placed; `soft-*` policies place it anyway. `*-anti-affinity` spreads
   * members over different hosts, `*-affinity` packs them on one host.
   * Changing it replaces the group.
   */
  policy: AffinityGroupPolicy;
  /**
   * Project of the affinity group. Defaults to the profile's project.
   * Changing it replaces the group.
   */
  projectId?: string;
  /**
   * Region of the affinity group. Defaults to the profile's region.
   * Changing it replaces the group.
   */
  region?: string;
}

export interface AffinityGroupAttributes {
  /** Affinity group id (UUID); pass it as `Server.affinityGroup`. */
  affinityGroupId: string;
  /** Name of the affinity group. */
  name: string;
  /** Placement policy. */
  policy: string;
  /** Ids of the servers placed in the group. */
  members: string[];
  /** Project of the affinity group. */
  projectId: string;
  /** Region of the affinity group. */
  region: string;
}

export type AffinityGroup = Resource<
  "Stackit.IaaS.AffinityGroup",
  AffinityGroupProps,
  AffinityGroupAttributes,
  never,
  Providers
>;

/**
 * A STACKIT server affinity group: a placement policy that keeps member
 * servers on the same host (affinity) or on different hosts
 * (anti-affinity). Servers join a group at creation through
 * `Server.affinityGroup`.
 *
 * STACKIT has no update API for affinity groups, so every change replaces
 * the group. Affinity groups carry no labels: Alchemy recognizes its own
 * group by the id in state, or by the generated physical name (which
 * embeds the resource's instance id). A group with an explicit `name` found
 * without state is reported as unowned and needs `--adopt`. `alchemy
 * unsafe nuke` enumerates only groups whose name has the generated shape,
 * so a group with a hand-chosen name of that shape is deleted too.
 *
 * ### Spreading servers over hosts
 * **Example:** Anti-affinity for a replicated service
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const group = yield* Stackit.IaaS.AffinityGroup("Replicas", {
 *   policy: "soft-anti-affinity",
 * });
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * for (const replica of ["A", "B"]) {
 *   yield* Stackit.IaaS.Server(`Replica${replica}`, {
 *     machineType: "g1.1",
 *     bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *     networking: { networkId: network.networkId },
 *     affinityGroup: group.affinityGroupId,
 *   });
 * }
 * ```
 *
 * ### Replacement
 * Any change (name, policy, project, region) creates a new group and
 * deletes the old one. Servers keep their placement until they are
 * recreated, and a server still in the old group can block its deletion;
 * replace the servers together with the group.
 *
 * @resource
 * @product STACKIT Compute Engine
 * @category IaaS
 */
export const AffinityGroup = Resource<AffinityGroup>("Stackit.IaaS.AffinityGroup");

const toAttrs = (group: iaas.AffinityGroup, scope: ProjectScope): AffinityGroupAttributes => ({
  affinityGroupId: group.id ?? "",
  name: group.name,
  policy: group.policy,
  members: [...(group.members ?? [])],
  ...scope,
});

const getGroup = (scope: ProjectScope, affinityGroupId: string) =>
  iaas
    .getAffinityGroup({ ...scope, affinityGroupId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const observe = Effect.fn(function* (
  scope: ProjectScope,
  name: string,
  policy: string | undefined,
  affinityGroupId: string | undefined,
) {
  if (affinityGroupId !== undefined) {
    const byId = yield* getGroup(scope, affinityGroupId);
    if (byId !== undefined) return byId;
  }
  // Crash recovery: no labels, so look the group up by its name.
  const { items } = yield* iaas.listAffinityGroups(scope);
  return items.find(
    (group) => group.name === name && (policy === undefined || group.policy === policy),
  );
});

export const AffinityGroupProvider = () =>
  Provider.succeed(AffinityGroup, {
    stables: ["affinityGroupId", "name", "policy", "projectId", "region"],
    // Nuke ordering: `Stackit.IaaS.Server` declares a dependency on this type,
    // so a group's member servers go first.

    // No labels: only groups with a generated name are enumerated.
    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listAffinityGroups(scope);
      return items
        .filter(
          (group) =>
            group.id !== undefined && isGeneratedPhysicalName(group.name, IAAS_NAME_MAX_LENGTH),
        )
        .map((group) => toAttrs(group, scope));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // Delete-first for an explicit name: the group is found by it, and an
      // unresolved prop can resolve to the name and policy it already has. A
      // generated name carries the generation, so it never collides.
      if (
        hasUnresolvedTrigger<AffinityGroupProps>(news, ["projectId", "region", "policy", "name"])
      ) {
        return {
          action: "replace",
          deleteFirst: rawProp<AffinityGroupProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<AffinityGroupProps>(news);
      if (yield* projectScopeChanged(resolved, output)) return { action: "replace" } as const;
      if (resolved.policy !== output.policy) return { action: "replace" } as const;
      const renamed =
        resolved.name !== undefined ? resolved.name !== output.name : olds?.name !== undefined;
      if (renamed) return { action: "replace" } as const;
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe(scope, name, olds?.policy, output?.affinityGroupId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope);
      // Owned when state recorded it, when it carries the generated name
      // (which embeds this resource's instance id), or when it is the
      // generation being replaced.
      const owned =
        output !== undefined ||
        olds?.name === undefined ||
        previous?.affinityGroupId === attrs.affinityGroupId;
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = yield* iaasName(id, news.name);

      // Observe, then ensure. Nothing is mutable after create.
      let current = yield* observe(scope, name, news.policy, output?.affinityGroupId);
      if (current === undefined) {
        current = yield* iaas.createAffinityGroup({ ...scope, name, policy: news.policy });
      }
      if (current.id === undefined) {
        return yield* new AffinityGroupIdMissing({
          resourceName: name,
          message: `STACKIT returned affinity group ${name} without an id`,
        });
      }
      return toAttrs(current, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* iaas
        .deleteAffinityGroup({ ...scope, affinityGroupId: output.affinityGroupId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `STACKIT affinity group ${output.name}`,
        read: getGroup(scope, output.affinityGroupId),
        timeout: "1 minute",
      });
    }),
  });
