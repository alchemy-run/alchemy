import * as sfs from "@distilled.cloud/stackit/sfs";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { projectScopeChanged, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { waitFor } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  labelsChanged,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  type FileStorageScope,
  generatedName,
  getPolicyOrUndefined,
  listAllPolicies,
  type ObservedPolicy,
  requirePolicy,
  SETTLE_TIMEOUT,
} from "./internal.ts";

/** What clients in a range may do with a share. */
export interface ShareExportPolicyClient {
  /**
   * CIDR ranges the rule applies to, e.g. `10.0.0.0/24`. At least one. The pool's `ipAcl`
   * still limits who gets in.
   */
  ipAcl: string[];
  /**
   * Whether these clients can only mount read-only.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Whether to honor set-UUID.
   * @default false
   */
  setUuid?: boolean;
  /**
   * Whether these clients have root access on the share.
   * @default true
   */
  superUser?: boolean;
  /** Description of the rule. */
  description?: string;
}

/** One rule of a share export policy. */
export interface ShareExportPolicyRule extends ShareExportPolicyClient {
  /**
   * Position of the rule: a client matching several rules gets the one with the lowest
   * `order`.
   */
  order: number;
}

export interface ShareExportPolicyProps {
  /**
   * Name of the policy, which is how shares refer to it. STACKIT can't rename a policy,
   * so changing it replaces the policy. No data is lost: shares that read `policy.name`
   * move to the new policy before the old one goes.
   * Removing an explicit name keeps the policy under the name it has.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * The policy's rules, at most 10 together with those `MountShare` adds. Compared by
   * `order`, and written as a whole list. Updates in place. Omitting it on an adopted
   * policy leaves its rules alone.
   *
   * @default no rules
   */
  rules?: ShareExportPolicyRule[];
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`,
   * `alchemy.id`, `alchemy.instance`) are always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the policy. Changing it replaces the policy.
   *
   * @default the profile's project
   */
  projectId?: string;
  /**
   * Region of the policy. Changing it replaces the policy.
   *
   * @default the profile's region
   */
  region?: string;
}

/** The binding contract of a {@link ShareExportPolicy}: clients to let in. */
export interface ShareExportPolicyBinding {
  /** Clients `MountShare` adds, as rules after the policy's own. */
  clients?: ShareExportPolicyClient[];
}

export interface ShareExportPolicyAttributes {
  /** STACKIT policy id. Stable across updates. */
  policyId: string;
  /** Project that owns the policy. */
  projectId: string;
  /** Region of the policy. */
  region: string;
  /** Name of the policy. */
  name: string;
  /** The rules on the policy, its own and those bindings added, by `order`. */
  rules: ShareExportPolicyRule[];
  /** Number of shares using the policy. */
  sharesUsingExportPolicy: number | undefined;
  /** When the policy was created. */
  createdAt: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type ShareExportPolicy = Resource<
  "Stackit.FileStorage.ShareExportPolicy",
  ShareExportPolicyProps,
  ShareExportPolicyAttributes,
  ShareExportPolicyBinding,
  Providers
>;

/**
 * A STACKIT File Storage share export policy: rules saying which clients can mount a
 * {@link Share}, read-only or read-write. Without one a share is read-only, so read-write
 * access starts here.
 *
 * Rules and labels update in place. The name, project and region replace the policy,
 * which holds no data. A rule can only narrow the `ipAcl` of the pool: a client outside
 * it stays out whatever the policy says.
 *
 * Destroying a policy waits briefly for the shares using it to let go, and then STACKIT
 * refuses it while a share still does: Alchemy doesn't detach shares it isn't deleting.
 *
 * A policy costs nothing by itself.
 *
 * Ownership is tracked with labels. A policy with the same name that lacks them is
 * reported as unowned and only taken over with `--adopt`.
 *
 * ### Creating a Policy
 * **Example:** Read-write for one network
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const policy = yield* Stackit.FileStorage.ShareExportPolicy("Clients", {
 *   rules: [{ order: 1, ipAcl: ["10.0.0.0/24"] }],
 * });
 * ```
 *
 * **Example:** Read-only for most, no root for anyone
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const policy = yield* Stackit.FileStorage.ShareExportPolicy("Clients", {
 *   name: "assets-clients",
 *   rules: [
 *     {
 *       order: 1,
 *       ipAcl: ["10.0.0.10/32"],
 *       superUser: false,
 *       description: "the writer",
 *     },
 *     {
 *       order: 2,
 *       ipAcl: ["10.0.0.0/24"],
 *       readOnly: true,
 *       superUser: false,
 *       description: "everyone else",
 *     },
 *   ],
 *   labels: { env: "production" },
 * });
 * ```
 *
 * ### Attaching a Policy to a Share
 * **Example:** A share using the policy by name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const policy = yield* Stackit.FileStorage.ShareExportPolicy("Clients", {
 *   rules: [{ order: 1, ipAcl: ["10.0.0.0/24"] }],
 * });
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * const share = yield* Stackit.FileStorage.Share("Assets", {
 *   resourcePoolId: pool.resourcePoolId,
 *   spaceHardLimitGigabytes: 100,
 *   exportPolicyName: policy.name,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the name creates a new policy
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The rules move with it. Read `policy.name` in the share so the share follows.
 * const policy = yield* Stackit.FileStorage.ShareExportPolicy("Clients", {
 *   name: "assets-clients-v2",
 *   rules: [{ order: 1, ipAcl: ["10.0.0.0/24"] }],
 * });
 * ```
 *
 * @resource
 * @product STACKIT File Storage
 * @category FileStorage
 */
export const ShareExportPolicy = Resource<ShareExportPolicy>(
  "Stackit.FileStorage.ShareExportPolicy",
);

const DEFAULT_READ_ONLY = false;
const DEFAULT_SET_UUID = false;
const DEFAULT_SUPER_USER = true;

/** A rule with the defaults the API fills in, for comparing and for attributes. */
const normalizeRule = (rule: {
  readonly order?: number;
  readonly ipAcl?: ReadonlyArray<string>;
  readonly readOnly?: boolean;
  readonly setUuid?: boolean;
  readonly superUser?: boolean;
  readonly description?: string | null;
}) => ({
  order: rule.order ?? 0,
  ipAcl: [...(rule.ipAcl ?? [])].sort(),
  readOnly: rule.readOnly ?? DEFAULT_READ_ONLY,
  setUuid: rule.setUuid ?? DEFAULT_SET_UUID,
  superUser: rule.superUser ?? DEFAULT_SUPER_USER,
  description: rule.description ?? "",
});

const byOrder = (a: { readonly order: number }, b: { readonly order: number }) => a.order - b.order;

/** Whether two rule lists say the same thing, order-insensitively and by each rule's `order`. */
const sameRules = (
  a: ReadonlyArray<Parameters<typeof normalizeRule>[0]> | undefined,
  b: ReadonlyArray<Parameters<typeof normalizeRule>[0]> | undefined,
) =>
  JSON.stringify((a ?? []).map(normalizeRule).sort(byOrder)) ===
  JSON.stringify((b ?? []).map(normalizeRule).sort(byOrder));

/**
 * The policy's whole rule list: its `rules` prop, then one rule per distinct client its
 * bindings ask for, in a stable order. The API only takes the whole list.
 */
const desiredRules = (
  own: ReadonlyArray<ShareExportPolicyRule> | undefined,
  bindings: ReadonlyArray<{ readonly data: ShareExportPolicyBinding }>,
): ShareExportPolicyRule[] => {
  const clients = new Map<string, ShareExportPolicyClient>();
  for (const binding of bindings) {
    for (const client of binding.data.clients ?? []) {
      const { order: _order, ...key } = normalizeRule(client);
      clients.set(JSON.stringify(key), client);
    }
  }
  const rules = [...(own ?? [])];
  let order = rules.reduce((highest, rule) => Math.max(highest, rule.order), 0);
  for (const [, client] of [...clients.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    order += 1;
    rules.push({ ...client, order });
  }
  return rules;
};

const toAttrs = (scope: FileStorageScope, policy: ObservedPolicy): ShareExportPolicyAttributes => ({
  policyId: policy.id,
  projectId: scope.projectId,
  region: scope.region,
  name: policy.name ?? "",
  rules: (policy.rules ?? [])
    .map((rule) => {
      const { description, ...normalized } = normalizeRule(rule);
      return description === "" ? normalized : { ...normalized, description };
    })
    .sort(byOrder),
  sharesUsingExportPolicy: policy.sharesUsingExportPolicy,
  createdAt: policy.createdAt,
  labels: stripInternalLabels(policy.labels),
});

/** The policy with this name, if any. */
const findPolicyByName = (scope: FileStorageScope, name: string) =>
  listAllPolicies(scope).pipe(Effect.map((all) => all.find((policy) => policy.name === name)));

export const ShareExportPolicyProvider = () =>
  Provider.succeed(ShareExportPolicy, {
    stables: ["policyId", "projectId", "region", "name"],
    // Nuke ordering: `Share` declares a dependency on this type, so shares go first.

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const policies = yield* listAllPolicies(scope);
      return policies
        .filter((policy) => isAlchemyOwned(policy.labels))
        .map((policy) => toAttrs(scope, policy));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An explicit name can resolve to the one the policy has, and a name can't exist
      // twice in a project and region: the old policy goes first. A generated name
      // carries the generation, so the new policy can come up first.
      if (hasUnresolvedTrigger<ShareExportPolicyProps>(news, ["name", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<ShareExportPolicyProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ShareExportPolicyProps>(news);
      const scopeChanged = yield* projectScopeChanged(resolved, output);
      const nameChanged = resolved.name !== undefined && resolved.name !== output.name;
      // A new name or a new scope can't collide with the old policy, so the new one
      // comes up first and shares move to it before the old one goes.
      if (scopeChanged || nameChanged) return { action: "replace" } as const;
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.policyId !== undefined) {
        const byId = yield* getPolicyOrUndefined(scope, output.policyId);
        if (byId !== undefined) return toAttrs(scope, byId);
      }
      const generated = yield* generatedName(id);
      const name = output?.name ?? olds?.name ?? generated;
      const found = yield* findPolicyByName(scope, name);
      if (found === undefined) return undefined;
      const attrs = toAttrs(scope, found);
      // The generation being replaced, matched by id: a name only means something
      // within one project and region.
      if (previous?.policyId === found.id) return attrs;
      // A generated name holds this generation's instance id.
      if (name === generated) return attrs;
      // A crashed create has neither state nor a previous generation, and any
      // generation of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      const owned =
        (yield* hasAlchemyLabels(id, found.labels)) &&
        (generation === undefined || hasInstanceLabel(generation, found.labels));
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output, bindings }) {
      const scope = yield* resolveProjectScope(news, output);
      const generated = yield* generatedName(id);
      const name = news.name ?? output?.name ?? generated;
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const rules = desiredRules(news.rules, bindings);
      const isThisGeneration = (found: ObservedPolicy) =>
        Effect.gen(function* () {
          if (name === generated) return true;
          return (
            (yield* hasAlchemyLabels(id, found.labels)) &&
            hasInstanceLabel(instanceId, found.labels)
          );
        });

      // 1. Observe — `output` is a cache for the id, and only names the desired policy
      // while it sits in the same project and region. Without it, only this generation's
      // policy can be claimed.
      let current: ObservedPolicy | undefined;
      if (
        output?.policyId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getPolicyOrUndefined(scope, output.policyId);
      }
      if (current === undefined) {
        const named = yield* findPolicyByName(scope, name);
        if (named !== undefined && (yield* isThisGeneration(named))) current = named;
      }

      // 2. Ensure
      if (current === undefined) {
        current = yield* sfs
          .createShareExportPolicy({
            ...scope,
            name,
            labels,
            // The API takes no `rules: null`, and an empty policy needs none.
            ...(rules.length > 0 ? { rules } : {}),
          })
          .pipe(
            Effect.flatMap(requirePolicy),
            // Lost a race against our own create: observe it. Anything else holding
            // the name is not ours, and still fails.
            Effect.catchTag("Conflict", (error) =>
              Effect.gen(function* () {
                const found = yield* findPolicyByName(scope, name);
                return found !== undefined && (yield* isThisGeneration(found))
                  ? found
                  : yield* Effect.fail(error);
              }),
            ),
          );
      }

      // 3. Sync — observed against desired. The API replaces the whole rule list, so a
      // rule only `olds` knows is removed by leaving it out. Adopting a policy with no
      // `rules` prop and no bindings leaves its clients in place.
      const leaveRules = olds === undefined && news.rules === undefined && rules.length === 0;
      const rulesDiffer = !leaveRules && !sameRules(current.rules, rules);
      const labelsDiffer = labelsChanged(current.labels, labels);
      if (rulesDiffer || labelsDiffer) {
        current = yield* sfs
          .updateShareExportPolicy({
            ...scope,
            policyId: current.id,
            ...(rulesDiffer ? { rules } : {}),
            ...(labelsDiffer ? { labels } : {}),
          })
          .pipe(Effect.flatMap(requirePolicy));
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { policyId } = output;
      const current = yield* getPolicyOrUndefined(scope, policyId);
      if (current === undefined) return;
      // A share deleted a moment ago may still count. One that stays is no reason to
      // keep waiting: the delete below reports it.
      yield* waitFor({
        resource: `the shares using STACKIT File Storage share export policy ${policyId}`,
        read: getPolicyOrUndefined(scope, policyId),
        ready: (policy) => (policy?.sharesUsingExportPolicy ?? 0) === 0,
        timeout: SETTLE_TIMEOUT,
      }).pipe(Effect.catchTag("Stackit.WaitTimeout", () => Effect.void));
      yield* sfs
        .deleteShareExportPolicy({ ...scope, policyId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
