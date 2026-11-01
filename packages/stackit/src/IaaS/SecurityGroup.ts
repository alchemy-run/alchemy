import * as iaas from "@distilled.cloud/stackit/iaas";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import { waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, hasAlchemyLabels, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  findOwnedByName,
  iaasName,
  labelsPatch,
  ownedOnly,
  projectScopeChanged,
  readGeneration,
  resolveProjectScope,
  type ProjectScope,
} from "./internal.ts";

/** The create response of a security group carried no id. */
export class SecurityGroupIdMissing extends Data.TaggedError(
  "Stackit.IaaS.SecurityGroupIdMissing",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

export interface SecurityGroupProps {
  /**
   * Security group name. Updated in place. If omitted, a unique name is
   * generated from the app, stage and logical id.
   */
  name?: string;
  /**
   * Project to create the security group in. Defaults to the profile's
   * project. Changing it replaces the security group.
   */
  projectId?: string;
  /**
   * Region of the security group. Defaults to the profile's region.
   * Changing it replaces the security group.
   */
  region?: string;
  /** Free-text description. Updated in place; not managed when omitted. */
  description?: string;
  /**
   * Whether the security group is stateful (return traffic of an allowed
   * connection is allowed automatically). Changing it replaces the
   * security group.
   * @default true
   */
  stateful?: boolean;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`,
   * `alchemy.stage`, `alchemy.id`) are added automatically.
   */
  labels?: Record<string, string>;
}

export interface SecurityGroupAttributes {
  /** Security group id (UUID). */
  securityGroupId: string;
  /** Security group name. */
  name: string;
  /** Project the security group belongs to. */
  projectId: string;
  /** Region of the security group. */
  region: string;
  /** Description, if any. */
  description: string | undefined;
  /** Whether the security group is stateful. */
  stateful: boolean;
  /**
   * Ids of the rules currently in the group, including the default egress
   * rules STACKIT adds and rules managed by {@link SecurityGroupRule}.
   */
  ruleIds: string[];
  /** User labels (Alchemy's ownership labels stripped). */
  labels: Record<string, string>;
}

export type SecurityGroup = Resource<
  "Stackit.IaaS.SecurityGroup",
  SecurityGroupProps,
  SecurityGroupAttributes,
  never,
  Providers
>;

/**
 * A STACKIT IaaS security group: a set of firewall rules applied to the
 * network interfaces (and through them, the servers) that reference it.
 * Rules are their own resources, {@link SecurityGroupRule}; STACKIT adds
 * default egress rules to every new group.
 *
 * Name, description and labels are updated in place; `stateful` cannot
 * change.
 *
 * ### Creating a security group
 * **Example:** Security group with an SSH rule
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const web = yield* Stackit.IaaS.SecurityGroup("Web", {
 *   description: "Web servers",
 * });
 * yield* Stackit.IaaS.SecurityGroupRule("WebSsh", {
 *   securityGroupId: web.securityGroupId,
 *   direction: "ingress",
 *   protocol: "tcp",
 *   portRange: { min: 22, max: 22 },
 *   ipRange: "203.0.113.0/24",
 * });
 * ```
 *
 * **Example:** Stateless security group
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const group = yield* Stackit.IaaS.SecurityGroup("Edge", {
 *   stateful: false,
 *   labels: { tier: "edge" },
 * });
 * ```
 *
 * ### Using a security group
 * **Example:** Apply the group to a network interface
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const web = yield* Stackit.IaaS.SecurityGroup("Web", {});
 * const nic = yield* Stackit.IaaS.NetworkInterface("WebNic", {
 *   networkId: network.networkId,
 *   securityGroups: [web.securityGroupId],
 * });
 * ```
 *
 * ### Replacement
 * Changing `stateful`, `projectId` or `region` creates a new security
 * group before deleting the old one. Network interfaces referencing the
 * old group keep it until they are updated to the new id; STACKIT refuses
 * to delete a group that is still in use.
 *
 * @resource
 * @product STACKIT Security Groups
 * @category IaaS
 */
export const SecurityGroup = Resource<SecurityGroup>("Stackit.IaaS.SecurityGroup");

const toAttrs = (group: iaas.SecurityGroup, scope: ProjectScope): SecurityGroupAttributes => ({
  securityGroupId: group.id ?? "",
  name: group.name,
  ...scope,
  description: group.description,
  stateful: group.stateful ?? true,
  ruleIds: (group.rules ?? []).flatMap((rule) => (rule.id === undefined ? [] : [rule.id])),
  labels: stripInternalLabels(group.labels),
});

const getGroup = (scope: ProjectScope, securityGroupId: string) =>
  iaas
    .getSecurityGroup({ ...scope, securityGroupId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const observe = Effect.fn(function* (
  id: string,
  name: string,
  scope: ProjectScope,
  securityGroupId: string | undefined,
  stateful: boolean | undefined,
  instanceId: string | undefined,
) {
  if (securityGroupId !== undefined) {
    const byId = yield* getGroup(scope, securityGroupId);
    if (byId !== undefined) return byId;
  }
  const { items } = yield* iaas.listSecurityGroups(scope);
  return yield* findOwnedByName(id, name, items, {
    instanceId,
    compatible: (group) => stateful === undefined || (group.stateful ?? true) === stateful,
  });
});

export const SecurityGroupProvider = () =>
  Provider.succeed(SecurityGroup, {
    stables: ["securityGroupId", "projectId", "region", "stateful"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { items } = yield* iaas.listSecurityGroups(scope);
      return ownedOnly(items).map((group) => toAttrs(group, scope));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (
        output !== undefined &&
        hasUnresolvedTrigger<SecurityGroupProps>(news, ["projectId", "region", "stateful"])
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (yield* projectScopeChanged(news, output)) return { action: "replace" } as const;
      if (output !== undefined && (news.stateful ?? true) !== output.stateful) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const name = output?.name ?? (yield* iaasName(id, olds?.name));
      const observed = yield* observe(
        id,
        name,
        scope,
        output?.securityGroupId,
        // An unset prop means the default, not "any".
        olds === undefined ? undefined : (olds.stateful ?? true),
        readGeneration({ instanceId, output, previous }),
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(observed, scope);
      return (yield* hasAlchemyLabels(id, observed.labels)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const name = yield* iaasName(id, news.name);
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const stateful = news.stateful ?? true;

      let current = yield* observe(id, name, scope, output?.securityGroupId, stateful, instanceId);
      if (current === undefined) {
        current = yield* iaas.createSecurityGroup({
          ...scope,
          name,
          description: news.description,
          stateful,
          labels,
        });
      }
      const securityGroupId = current.id;
      if (securityGroupId === undefined) {
        return yield* new SecurityGroupIdMissing({
          resourceName: name,
          message: `STACKIT returned security group ${name} without an id`,
        });
      }

      const labelPatch = labelsPatch(current.labels, labels);
      const describe =
        news.description !== undefined && current.description !== news.description
          ? news.description
          : undefined;
      if (current.name !== name || describe !== undefined || labelPatch !== undefined) {
        current = yield* iaas.updateSecurityGroup({
          ...scope,
          securityGroupId,
          name: current.name !== name ? name : undefined,
          description: describe,
          labels: labelPatch,
        });
      }
      return toAttrs({ ...current, id: securityGroupId }, scope);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      // `Conflict` while network interfaces still reference the group.
      yield* iaas.deleteSecurityGroup({ ...scope, securityGroupId: output.securityGroupId }).pipe(
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitUntilGone({
        resource: `STACKIT security group ${output.name}`,
        read: getGroup(scope, output.securityGroupId),
        timeout: "1 minute",
      });
    }),
  });
