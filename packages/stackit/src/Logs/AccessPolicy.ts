import * as logs from "@distilled.cloud/stackit/logs";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScope, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import {
  desiredGenerationLabels,
  diffLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  managedLabels,
  reservedLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { conflictRetry, findOwned, listInstances, scopeRequest, userLabels } from "./internal.ts";

/** What a policy allows on its instance's logs. */
export type AccessPolicyPermission = "read" | "write";

export interface AccessPolicyProps {
  /** Instance the policy belongs to. Changing it replaces the policy. */
  instanceId: string;
  /**
   * Email of the STACKIT IAM subject: a user, a group, or a service account's `email`. The
   * API can't change it, so changing it replaces the policy. An instance holds one policy
   * per subject.
   */
  email: string;
  /** What the subject may do. Updates in place. */
  permissions: AccessPolicyPermission[];
  /**
   * Description, at most 100 characters. Updates in place; omit to leave the live value
   * alone.
   */
  description?: string;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Project that owns the instance. Changing it replaces the policy. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the policy. @default the profile's region */
  region?: string;
}

export interface AccessPolicyAttributes {
  /** STACKIT access policy id (UUID). Stable across updates. */
  accessPolicyId: string;
  /** Instance the policy belongs to. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Email of the STACKIT IAM subject. */
  email: string;
  /** What the subject may do. */
  permissions: string[];
  /** Description, if any. */
  description: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type AccessPolicy = Resource<
  "Stackit.Logs.AccessPolicy",
  AccessPolicyProps,
  AccessPolicyAttributes,
  never,
  Providers
>;

/**
 * Grants a STACKIT IAM subject read or write access to the logs of a
 * `Stackit.Logs.Instance`, without an access token.
 *
 * Changing `instanceId`, `email`, `projectId` or `region` replaces the policy. A policy
 * for the same email that lacks Alchemy's labels is reported as unowned and only taken
 * over with `--adopt`.
 *
 * See [STACKIT's Logs docs](https://docs.stackit.cloud/products/logging-and-monitoring/logs/).
 *
 * :::caution[Changing `instanceId`, `email`, `projectId` or `region` replaces the Policy]
 * A new policy is created and the old one is deleted, so the old subject loses access.
 * :::
 *
 * ### Granting Access
 * **Example:** Let a group read an instance's logs
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.Logs.Instance("Logs", { acl: ["203.0.113.7/32"] });
 * yield* Stackit.Logs.AccessPolicy("Oncall", {
 *   instanceId: logs.instanceId,
 *   email: "oncall@example.com",
 *   permissions: ["read"],
 *   description: "On-call team",
 * });
 * ```
 *
 * **Example:** Let a service account read and write
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.Logs.Instance("Logs", { acl: ["203.0.113.7/32"] });
 * const account = yield* Stackit.IAM.ServiceAccount("Shipper", {});
 * yield* Stackit.Logs.AccessPolicy("ShipperAccess", {
 *   instanceId: logs.instanceId,
 *   email: account.email,
 *   permissions: ["read", "write"],
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing `email` makes a new policy
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const logs = yield* Stackit.Logs.Instance("Logs", { acl: ["203.0.113.7/32"] });
 * // The new subject's policy is created first, then the old subject's is deleted.
 * yield* Stackit.Logs.AccessPolicy("Oncall", {
 *   instanceId: logs.instanceId,
 *   email: "oncall-eu@example.com",
 *   permissions: ["read"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Logs
 * @category Logs
 */
export const AccessPolicy = Resource<AccessPolicy>("Stackit.Logs.AccessPolicy");

const toAttrs = (
  scope: ProjectScope,
  instanceId: string,
  policy: logs.AccessPolicy,
): AccessPolicyAttributes => ({
  accessPolicyId: policy.id,
  instanceId,
  projectId: scope.projectId,
  region: scope.region,
  email: policy.email,
  permissions: [...policy.permissions],
  description: policy.description === "" ? undefined : policy.description,
  labels: userLabels(policy.labels),
});

const getPolicyOrUndefined = (scope: ProjectScope, instanceId: string, pId: string) =>
  logs
    .getAccessPolicy({ ...scopeRequest(scope), instanceId, pId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/** An instance's policies, or none once the instance is gone. The API doesn't page this list. */
const listPolicies = (scope: ProjectScope, instanceId: string) =>
  logs.listAccessPolicies({ ...scopeRequest(scope), instanceId }).pipe(
    Effect.map(({ policies }) => policies),
    Effect.catchTag("NotFound", () => Effect.succeed<logs.AccessPolicy[]>([])),
  );

/** One policy per email, in whatever case the API keeps it. */
const sameEmail = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const AccessPolicyProvider = () =>
  Provider.succeed(AccessPolicy, {
    stables: ["accessPolicyId", "instanceId", "projectId", "region", "email"],
    nuke: { dependsOn: ["Stackit.Logs.Instance"] },

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listInstances(scope);
      const found: AccessPolicyAttributes[] = [];
      for (const instance of instances.filter((item) => isAlchemyOwned(item.labels))) {
        const policies = yield* listPolicies(scope, instance.id);
        for (const policy of policies.filter((item) => isAlchemyOwned(item.labels))) {
          found.push(toAttrs(scope, instance.id, policy));
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the one the policy already has, and the spec
      // refuses a second policy for one email (`accessPolicyConflict`).
      if (
        hasUnresolvedTrigger<AccessPolicyProps>(news, [
          "instanceId",
          "email",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<AccessPolicyProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.instanceId !== output.instanceId ||
        !sameEmail(resolved.email, output.email) ||
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId: generationId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      if (output !== undefined) {
        const byId = yield* getPolicyOrUndefined(scope, instanceId, output.accessPolicyId);
        if (byId !== undefined) return toAttrs(scope, instanceId, byId);
      }
      const policies = yield* listPolicies(scope, instanceId);
      // A crashed create has neither state nor a previous generation, and any
      // generation of this logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId: generationId, output, previous });
      const owned = yield* findOwned(id, policies, generation);
      if (owned !== undefined) return toAttrs(scope, instanceId, owned);
      const email = output?.email ?? olds?.email;
      if (email === undefined) return undefined;
      const named = policies.find((policy) => sameEmail(policy.email, email));
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, instanceId, named);
      // A policy id is only unique on its instance, and an instance id per scope.
      const isPrevious =
        previous?.accessPolicyId === named.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId: generationId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const instanceId = news.instanceId;
      const request = { ...scopeRequest(scope), instanceId };
      const labels = yield* desiredGenerationLabels(id, generationId, news.labels);

      // 1. Observe — by cached id, while it sits on the desired instance, then by this
      // generation's labels (a crashed create).
      let current: logs.AccessPolicy | undefined;
      if (
        output?.instanceId === instanceId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        current = yield* getPolicyOrUndefined(scope, instanceId, output.accessPolicyId);
      }
      if (current === undefined) {
        const policies = yield* listPolicies(scope, instanceId);
        current = yield* findOwned(id, policies, generationId);
      }

      // 2. Ensure
      if (current === undefined) {
        current = yield* logs
          .createAccessPolicy({
            ...request,
            email: news.email,
            permissions: [...news.permissions],
            labels,
            ...(news.description !== undefined ? { description: news.description } : {}),
          })
          .pipe(
            // The spec's `accessPolicyConflict`: the email has a policy. A concurrent
            // create of this very generation is a race; any other policy still fails,
            // because taking it over is `--adopt`'s decision.
            Effect.catchTag("Conflict", (error) =>
              listPolicies(scope, instanceId).pipe(
                Effect.map((policies) =>
                  policies.find(
                    (policy) =>
                      sameEmail(policy.email, news.email) &&
                      hasInstanceLabel(generationId, policy.labels),
                  ),
                ),
                Effect.flatMap((raced) =>
                  raced === undefined ? Effect.fail(error) : Effect.succeed(raced),
                ),
              ),
            ),
          );
      }
      const pId = current.id;

      // 3. Sync — the delta against the observed policy. PATCH's labels carry the whole
      // desired set; whether it replaces or merges them is undocumented.
      const { upsert, removed } = diffLabels(managedLabels(current.labels), labels);
      const delta = {
        ...(sameMembers(current.permissions, news.permissions)
          ? {}
          : { permissions: [...news.permissions] }),
        ...(news.description !== undefined && (current.description ?? "") !== news.description
          ? { description: news.description }
          : {}),
        ...(upsert.length > 0 || removed.length > 0
          ? { labels: { ...reservedLabels(current.labels), ...labels } }
          : {}),
      };
      if (Object.keys(delta).length > 0) {
        current = yield* logs
          .updateAccessPolicy({ ...request, pId, ...delta })
          .pipe(Effect.retry(conflictRetry));
      }

      // 4. Return
      return toAttrs(scope, instanceId, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      yield* logs
        .deleteAccessPolicy({
          ...scopeRequest(scope),
          instanceId: output.instanceId,
          pId: output.accessPolicyId,
        })
        .pipe(
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
