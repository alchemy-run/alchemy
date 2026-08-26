import * as redis from "@distilled.cloud/gcp/redis_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const DEFAULT_LOCATION = "us-central1";
const MAX_NAME_LENGTH = 63;
const OWNERSHIP_USERNAME = "alchemy-owner";

export type AclRule = {
  /**
   * Redis ACL username. For IAM auth this is an IAM user or service
   * account; otherwise any Redis ACL username. The username
   * `alchemy-owner` is reserved for Alchemy ownership stamping.
   */
  username?: string;
  /**
   * Redis OSS ACL rule string (e.g. `"on ~keys:* +get"`). See
   * https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/
   */
  rule?: string;
};

export type AclPolicyProps = {
  /**
   * ACL policy id (the `{acl_policy}` segment of
   * `projects/{project}/locations/{location}/aclPolicies/{acl_policy}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must match `^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$` (1-63
   * characters). Immutable — changing it replaces the policy.
   */
  aclPolicyId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the policy. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Redis ACL rules applied to clusters that attach this policy. Alchemy
   * appends a disabled `alchemy-owner` sentinel used for `list` / nuke
   * because ACL policies have no labels or description field.
   */
  rules?: AclRule[];
};

export type AclPolicy = Resource<
  "GCP.Redis.AclPolicy",
  AclPolicyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/aclPolicies/{acl_policy}`. */
    name: string;
    /** ACL policy id (last path segment). */
    aclPolicyId: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** User ACL rules (Alchemy ownership sentinel stripped). */
    rules: AclRule[];
    /** Server-reported state (`ACTIVE`, `UPDATING`, `DELETING`, …). */
    state: string | undefined;
    /** Server etag for optimistic concurrency. */
    etag: string | undefined;
    /** Deprecated drift-resolution version string, if present. */
    version: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Memorystore for Redis Cluster ACL policy.
 *
 * ACL policies have no labels field, so Alchemy stamps ownership into a
 * disabled `alchemy-owner` sentinel rule for `list` / `pnpm nuke:gcp`.
 * `aclPolicyId` and `location` are identity — changing either replaces
 * the policy. `rules` update in place. Create is synchronous; patch and
 * delete return long-running operations.
 *
 * Attach the policy to a Redis Cluster with the cluster's `aclPolicy`
 * field. A policy cannot be deleted while it is attached to a cluster.
 *
 * ### Creating an ACL Policy
 * **Example:** Generated name
 * ```typescript
 * const policy = yield* GCP.Redis.AclPolicy("AppAcl", {
 *   rules: [{ username: "app", rule: "on ~keys:* +get" }],
 * });
 * ```
 *
 * **Example:** Explicit id, location, and rules
 * ```typescript
 * const policy = yield* GCP.Redis.AclPolicy("AppAcl", {
 *   aclPolicyId: "app-acl",
 *   location: "us-central1",
 *   rules: [
 *     { username: "app", rule: "on ~keys:* +get" },
 *     { username: "readonly", rule: "off ~* -@all" },
 *   ],
 * });
 * ```
 *
 * ### Updating Rules
 * **Example:** Add a command to an existing user
 * ```typescript
 * const policy = yield* GCP.Redis.AclPolicy("AppAcl", {
 *   aclPolicyId: existing.aclPolicyId,
 *   location: "us-central1",
 *   rules: [{ username: "app", rule: "on ~keys:* +get +set" }],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Redis
 */
export const AclPolicy = Resource<AclPolicy>("GCP.Redis.AclPolicy");

export class AclPolicyNotResolved extends Data.TaggedError(
  "GCP.Redis.AclPolicyNotResolved",
)<{
  name: string;
}> {}

export class AclPolicyNotReady extends Data.TaggedError(
  "GCP.Redis.AclPolicyNotReady",
)<{
  name: string;
  state: string;
}> {}

export class AclPolicyOperationFailed extends Data.TaggedError(
  "GCP.Redis.AclPolicyOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class AclPolicyOperationPending extends Data.TaggedError(
  "GCP.Redis.AclPolicyOperationPending",
)<{
  operation: string;
}> {}

export class AclPolicyStillExists extends Data.TaggedError(
  "GCP.Redis.AclPolicyStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "aclpolicy";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

const resourceName = (project: string, location: string, aclPolicyId: string) =>
  `projects/${project}/locations/${location}/aclPolicies/${aclPolicyId}`;

const parseName = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const policiesAt = parts.lastIndexOf("aclPolicies");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    aclPolicyId:
      policiesAt >= 0 && parts[policiesAt + 1]
        ? parts[policiesAt + 1]!
        : lastSegment(name),
  };
};

const toId = (id: string, aclPolicyId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      aclPolicyId ??
      existing ??
      rfc1035(
        yield* createPhysicalName({
          id,
          maxLength: MAX_NAME_LENGTH,
          lowercase: true,
        }),
      )
    );
  });

const ruleOf = (rule: redis.AclRule | AclRule): AclRule => ({
  username: rule.username,
  rule: rule.rule,
});

const isOwnershipRule = (rule: redis.AclRule | AclRule) =>
  (rule.username ?? "") === OWNERSHIP_USERNAME;

const encodeOwnershipRule = (
  labels: Record<string, string>,
): redis.AclRule => ({
  username: OWNERSHIP_USERNAME,
  rule: `off ~${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ~${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ~${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]} -@all`,
});

const parseOwnershipRule = (
  rule: redis.AclRule | AclRule | undefined,
): Record<string, string> => {
  if (!isOwnershipRule(rule ?? {})) return {};
  const labels: Record<string, string> = {};
  for (const part of (rule?.rule ?? "").split(/\s+/)) {
    if (!part.startsWith("~")) continue;
    const body = part.slice(1);
    const eq = body.indexOf("=");
    if (eq > 0) {
      labels[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }
  return labels;
};

const ownershipLabelsOf = (
  rules: readonly (redis.AclRule | AclRule)[] | undefined,
): Record<string, string> => {
  for (const rule of rules ?? []) {
    const labels = parseOwnershipRule(rule);
    if (Object.keys(labels).some((key) => key.startsWith("alchemy-"))) {
      return labels;
    }
  }
  return {};
};

const hasOwnershipMarker = (
  rules: readonly (redis.AclRule | AclRule)[] | undefined,
) =>
  Object.keys(ownershipLabelsOf(rules)).some((key) =>
    key.startsWith("alchemy-"),
  );

const userRulesOf = (
  rules: readonly (redis.AclRule | AclRule)[] | undefined,
): AclRule[] =>
  (rules ?? []).filter((rule) => !isOwnershipRule(rule)).map(ruleOf);

const rulesKey = (rules: readonly AclRule[]) =>
  JSON.stringify(
    [...rules]
      .map((rule) => ({
        username: rule.username ?? "",
        rule: rule.rule ?? "",
      }))
      .sort(
        (left, right) =>
          left.username.localeCompare(right.username) ||
          left.rule.localeCompare(right.rule),
      ),
  );

const desiredRules = (
  news: AclPolicyProps,
  labels: Record<string, string>,
): redis.AclRule[] => [...userRulesOf(news.rules), encodeOwnershipRule(labels)];

const toAttrs = (policy: redis.AclPolicy, project: string) => {
  const name = policy.name ?? "";
  const parsed = parseName(name);
  return {
    name,
    aclPolicyId: parsed.aclPolicyId,
    project: parsed.project || project,
    location: parsed.location,
    rules: userRulesOf(policy.rules),
    state: policy.state,
    etag: policy.etag,
    version: policy.version,
  };
};

const isPlaceholder = (policy: redis.AclPolicy) => {
  const name = policy.name ?? "";
  return name.endsWith("/aclPolicies/-") || name.endsWith("/aclPolicies/");
};

const getByName = (name: string) =>
  redis
    .getProjectsLocationsAclPolicies({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitForOperation = (
  operation: redis.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        return yield* new AclPolicyOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new AclPolicyOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = redis.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<redis.Operation>({
                name,
                done: true,
              }),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new AclPolicyOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        return error
          ? Effect.fail(
              new AclPolicyOperationFailed({
                operation: name,
                message: error.message ?? "operation failed",
              }),
            )
          : Effect.succeed(current);
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.Redis.AclPolicyOperationPending",
        times: 10,
        schedule: Schedule.spaced("4 seconds"),
      }),
    );
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy
        ? Effect.succeed(policy)
        : Effect.fail(new AclPolicyNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Redis.AclPolicyNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilActive = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (policy): policy is redis.AclPolicy => policy !== undefined,
      () => new AclPolicyNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (policy) => {
        const state = policy.state ?? "ACTIVE";
        return state === "ACTIVE" || state === "STATE_UNSPECIFIED";
      },
      (policy) =>
        new AclPolicyNotReady({
          name,
          state: policy.state ?? "STATE_UNSPECIFIED",
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Redis.AclPolicyNotReady" ||
        error._tag === "GCP.Redis.AclPolicyNotResolved",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((policy) =>
      policy === undefined
        ? Effect.void
        : Effect.fail(new AclPolicyStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Redis.AclPolicyStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const AclPolicyProvider = () =>
  Provider.succeed(AclPolicy, {
    stables: ["name", "aclPolicyId", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;

      const previousId = olds?.aclPolicyId ?? output?.aclPolicyId;
      const nextId = news.aclPolicyId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(news.location ?? output?.location);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation;
      if (!replace) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const aclPolicyId = yield* toId(
        id,
        olds?.aclPolicyId,
        output?.aclPolicyId,
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, aclPolicyId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, ownershipLabelsOf(existing.rules)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* redis.listProjectsLocationsAclPolicies
          .pages({
            parent: `projects/${env.project}/locations/-`,
            pageSize: 1000,
          })
          .pipe(
            Stream.flatMap((page) =>
              Stream.fromIterable(page.aclPolicies ?? []),
            ),
            Stream.filter(
              (policy) =>
                !isPlaceholder(policy) && hasOwnershipMarker(policy.rules),
            ),
            Stream.map((policy) => toAttrs(policy, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
            Effect.catchTag("Forbidden", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const aclPolicyId = yield* toId(
        id,
        news.aclPolicyId,
        output?.aclPolicyId,
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, aclPolicyId);
      const ownership = yield* createInternalLabels(id);
      const bodyRules = desiredRules(news, ownership);

      let current = yield* getByName(output?.name ?? name);
      if (current !== undefined && (current.state ?? "") === "DELETING") {
        yield* waitUntilGone(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* redis
          .createProjectsLocationsAclPolicies({
            parent: `projects/${env.project}/locations/${location}`,
            aclPolicyId,
            body: { rules: bodyRules },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current =
          created && created.name && !isPlaceholder(created)
            ? created
            : yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new AclPolicyNotResolved({ name });
      }

      const state = current.state ?? "ACTIVE";
      if (state === "UPDATING" || state === "DELETING") {
        current = yield* waitUntilActive(name);
      }

      const rulesChanged =
        rulesKey(userRulesOf(current.rules)) !==
          rulesKey(userRulesOf(news.rules)) ||
        rulesKey([ruleOf(encodeOwnershipRule(ownership))]) !==
          rulesKey((current.rules ?? []).filter(isOwnershipRule).map(ruleOf));

      if (rulesChanged) {
        const patched = yield* redis
          .patchProjectsLocationsAclPolicies({
            name,
            updateMask: "rules",
            body: { name, rules: bodyRules },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* waitUntilActive(name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* redis
        .deleteProjectsLocationsAclPolicies({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true }).pipe(
          Effect.catchTag(
            "GCP.Redis.AclPolicyOperationPending",
            () => Effect.void,
          ),
        );
      }
      yield* waitUntilGone(output.name);
    }),
  });
