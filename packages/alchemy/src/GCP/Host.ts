import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Binding from "../Binding.ts";
import type { Input } from "../Input.ts";
import {
  Resource,
  type ResourceBinding,
  type ResourceLike,
} from "../Resource.ts";
import {
  projectRolesOf,
  revokeIamMembership,
  updateIamMembership,
  type GcpIamResourceKind,
} from "./IamPolicy.ts";
import { parseServiceAccountKey } from "./Token.ts";

export type { GcpIamResourceKind } from "./IamPolicy.ts";

/**
 * IAM grant a binding attaches to a GCP runtime host (Cloud Run
 * Service/Job/WorkerPool or Cloud Function) — the GCP analog of an AWS
 * binding's `policyStatements`. The role is granted to the host's runtime
 * service account.
 */
export type GcpIamGrant = {
  /**
   * Predefined or custom role, e.g. `roles/pubsub.publisher`. Pick the
   * narrowest role that covers the binding's operation.
   */
  role: string;
  /**
   * Grant on this one resource's IAM policy (the analog of an IAM
   * statement's `Resource: [arn]`). Omit only for services with no
   * resource-level IAM, in which case the role is granted on the project.
   */
  resource?: {
    kind: Exclude<GcpIamResourceKind, "project">;
    /** Full resource name, e.g. `projects/p/topics/t` (a bucket name for `storage.bucket`). */
    name: string;
  };
};

/**
 * Binding contract for GCP effectful hosts. Capability implementations
 * call `host.bind` with env (packed into the container/function) and IAM
 * grants (applied to the runtime service account).
 */
export type GcpHostBinding = {
  env?: Record<string, any>;
  iam?: GcpIamGrant[];
};

/**
 * One role granted to a host's runtime service account on one resource,
 * recorded on the host's attributes so a later deploy can revoke it once
 * the binding that asked for it is gone.
 */
export type AppliedIamGrant = {
  kind: GcpIamResourceKind;
  /** Full resource name, or the project id for `project`. */
  name: string;
  role: string;
};

const GCP_HOST_TYPES = new Set([
  "GCP.Run.Service",
  "GCP.Run.Job",
  "GCP.Run.WorkerPool",
  "GCP.CloudFunctions.Function",
]);

/**
 * True for any Alchemy GCP host that accepts {@link GcpHostBinding}.
 * HTTP `Binding.Service` implementations guard `host.bind` with this
 * before granting IAM / injecting env.
 */
export const isGcpHost = (
  value: ResourceLike | undefined,
): value is Resource<string, object, object, GcpHostBinding> =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  GCP_HOST_TYPES.has((value as { Type: string }).Type);

/** Merge the env and IAM grants of every binding attached to a host. */
export const collectHostBindings = (
  bindings: readonly ResourceBinding<GcpHostBinding>[],
): { env: Record<string, any>; iam: GcpIamGrant[] } => ({
  env: bindings
    .map((binding) => binding.data?.env)
    .reduce<Record<string, any>>((acc, next) => ({ ...acc, ...next }), {}),
  iam: bindings.flatMap((binding) => binding.data?.iam ?? []),
});

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

/**
 * Project number for the default Compute Engine service account
 * (`{number}-compute@developer.gserviceaccount.com`).
 */
export const projectNumber = (project: string) =>
  resourcemanager
    .getProjects({ name: `projects/${project}` })
    .pipe(Effect.map((resource) => lastSegment(resource.name ?? "")));

export const defaultComputeServiceAccount = (project: string) =>
  projectNumber(project).pipe(
    Effect.map((number) => `${number}-compute@developer.gserviceaccount.com`),
  );

/** 64-bit FNV-1a, hex. Deterministic and dependency-free. */
const fnv1a64 = (input: string): string => {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index++) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
};

/**
 * RFC1035 account id (6–30 chars) for the runtime service account Alchemy
 * mints for one physical host. The hash covers the host type and full
 * resource name, so two hosts never share an account — not across
 * stages, not a Service and a Job with the same id, and not the two
 * generations of a create-before-delete replacement.
 */
export const hostServiceAccountId = (
  hostType: string,
  resourceName: string,
): string => {
  const slug = lastSegment(resourceName)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12)
    .replace(/-+$/g, "");
  const hash = fnv1a64(`${hostType}:${resourceName}`).slice(0, 10);
  return /^[a-z]/.test(slug) ? `alch-${slug}-${hash}` : `alch-${hash}`;
};

export const hostServiceAccountEmail = (project: string, accountId: string) =>
  `${accountId}@${project}.iam.gserviceaccount.com`;

/** Display name stamped on Alchemy-minted host SAs so nuke can list them. */
export const ALCHEMY_HOST_SA_DISPLAY_NAME = "alchemy-host";

const serviceAccountName = (project: string, email: string) =>
  `projects/${project}/serviceAccounts/${email}`;

/**
 * Let the deploying principal and the serverless robots `actAs` the host
 * service account so Cloud Run / Functions accept it as the runtime
 * identity.
 */
const grantActAs = (project: string, email: string) =>
  Effect.gen(function* () {
    const number = yield* projectNumber(project);
    const members = [
      `serviceAccount:service-${number}@serverless-robot-prod.iam.gserviceaccount.com`,
      `serviceAccount:service-${number}@gcf-admin-robot.iam.gserviceaccount.com`,
    ];
    const keyFile = yield* Config.option(
      Config.String("GOOGLE_APPLICATION_CREDENTIALS"),
    );
    if (Option.isSome(keyFile)) {
      const fs = yield* FileSystem.FileSystem;
      const raw = yield* fs
        .readFileString(keyFile.value)
        .pipe(
          Effect.catchReason("PlatformError", "NotFound", () =>
            Effect.succeed(""),
          ),
        );
      if (raw.length > 0) {
        const parsed = yield* parseServiceAccountKey(raw).pipe(
          Effect.catchTag("AuthError", () => Effect.succeed(undefined)),
        );
        if (parsed?.client_email) {
          members.push(`serviceAccount:${parsed.client_email}`);
        }
      }
    }
    for (const member of members) {
      yield* updateIamMembership({
        kind: "iam.serviceAccount",
        name: serviceAccountName(project, email),
        member,
        add: ["roles/iam.serviceAccountUser"],
      });
    }
  });

/**
 * Create (or adopt) the runtime service account for one host and let
 * Cloud Run / Functions `actAs` it. `created` reports whether this call
 * minted it, so a failed first deploy can clean up only what it made.
 */
export const ensureHostServiceAccount = (options: {
  project: string;
  hostType: string;
  resourceName: string;
}) => {
  const accountId = hostServiceAccountId(
    options.hostType,
    options.resourceName,
  );
  const email = hostServiceAccountEmail(options.project, accountId);
  return Effect.gen(function* () {
    const existing = yield* iam
      .getProjectsServiceAccounts({
        name: serviceAccountName(options.project, email),
      })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    let created = false;
    if (existing?.email === undefined || existing.email.length === 0) {
      created = yield* iam
        .createProjectsServiceAccounts({
          name: `projects/${options.project}`,
          body: {
            accountId,
            serviceAccount: { displayName: ALCHEMY_HOST_SA_DISPLAY_NAME },
          },
        })
        .pipe(
          Effect.as(true),
          Effect.retry({
            while: (error) => error._tag === "ServiceAccountQuotaExceeded",
            times: 6,
            schedule: Schedule.exponential("2 seconds"),
          }),
          Effect.catchTag("Conflict", () => Effect.succeed(false)),
        );
    }
    yield* grantActAs(options.project, email);
    return { email, created };
  });
};

/** Retry Cloud Run / Functions create while IAM `actAs` is propagating. */
export const retryActAs = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => error._tag === "Forbidden",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const grantKey = (grant: AppliedIamGrant) =>
  `${grant.kind}\u0000${grant.name}\u0000${grant.role}`;

const groupByTarget = (grants: readonly AppliedIamGrant[]) => {
  const groups = new Map<
    string,
    { kind: GcpIamResourceKind; name: string; roles: Set<string> }
  >();
  for (const grant of grants) {
    const key = `${grant.kind}\u0000${grant.name}`;
    const group = groups.get(key) ?? {
      kind: grant.kind,
      name: grant.name,
      roles: new Set<string>(),
    };
    group.roles.add(grant.role);
    groups.set(key, group);
  }
  return [...groups.values()];
};

/** Desired grants for a host, deduplicated and resolved to concrete targets. */
export const desiredHostGrants = (
  project: string,
  grants: readonly GcpIamGrant[],
): AppliedIamGrant[] => {
  const unique = new Map<string, AppliedIamGrant>();
  for (const grant of grants) {
    if (grant.role.length === 0) continue;
    const applied: AppliedIamGrant =
      grant.resource === undefined
        ? { kind: "project", name: project, role: grant.role }
        : {
            kind: grant.resource.kind,
            name: grant.resource.name,
            role: grant.role,
          };
    unique.set(grantKey(applied), applied);
  }
  return [...unique.values()].sort((left, right) =>
    grantKey(left).localeCompare(grantKey(right)),
  );
};

/**
 * Converge the runtime service account's IAM onto the host's bindings.
 *
 * Every desired grant is added on its target resource. Grants recorded
 * on a previous deploy that no binding asks for any more are revoked.
 * For an Alchemy-minted account, the host project policy is additionally
 * synced against the observed policy, so roles granted out of band (or
 * lost from state) are revoked too; a user-supplied account is only ever
 * stripped of grants Alchemy itself recorded.
 */
export const syncHostIam = Effect.fn(function* (options: {
  project: string;
  serviceAccount: string;
  managed: boolean;
  bindings: readonly ResourceBinding<GcpHostBinding>[];
  previous: readonly AppliedIamGrant[] | undefined;
}) {
  const collected = collectHostBindings(options.bindings);
  const desired = desiredHostGrants(options.project, collected.iam);
  const desiredKeys = new Set(desired.map(grantKey));
  const stale = (options.previous ?? []).filter(
    (grant) => !desiredKeys.has(grantKey(grant)),
  );

  for (const group of groupByTarget(desired)) {
    yield* updateIamMembership({
      kind: group.kind,
      name: group.name,
      member: options.serviceAccount,
      add: group.roles,
    });
  }

  const isHostProject = (grant: { kind: string; name: string }) =>
    grant.kind === "project" && grant.name === options.project;

  if (options.managed) {
    const wanted = new Set(
      desired.filter(isHostProject).map((grant) => grant.role),
    );
    const held = yield* projectRolesOf(options.project, options.serviceAccount);
    const extra = held.filter((role) => !wanted.has(role));
    if (extra.length > 0) {
      yield* revokeIamMembership({
        kind: "project",
        name: options.project,
        member: options.serviceAccount,
        roles: extra,
      });
    }
  }

  for (const group of groupByTarget(stale)) {
    if (options.managed && isHostProject(group)) continue;
    yield* revokeIamMembership({
      kind: group.kind,
      name: group.name,
      member: options.serviceAccount,
      roles: group.roles,
    });
  }

  return { env: collected.env, grants: desired };
});

/** Revoke every recorded grant from the host's runtime service account. */
export const revokeHostIam = Effect.fn(function* (options: {
  serviceAccount: string;
  grants: readonly AppliedIamGrant[];
}) {
  for (const group of groupByTarget(options.grants)) {
    yield* revokeIamMembership({
      kind: group.kind,
      name: group.name,
      member: options.serviceAccount,
      roles: group.roles,
    });
  }
});

/**
 * Delete an Alchemy-minted host service account (no-op if it is already
 * gone) after revoking its project roles and every recorded grant, so no
 * `deleted:serviceAccount:` members linger on other resources.
 */
export const deleteHostServiceAccount = Effect.fn(function* (options: {
  project: string;
  email: string;
  grants?: readonly AppliedIamGrant[];
}) {
  yield* revokeHostIam({
    serviceAccount: options.email,
    grants: options.grants ?? [],
  });
  const held = yield* projectRolesOf(options.project, options.email);
  if (held.length > 0) {
    yield* revokeIamMembership({
      kind: "project",
      name: options.project,
      member: options.email,
      roles: held,
    });
  }
  yield* iam
    .deleteProjectsServiceAccounts({
      name: serviceAccountName(options.project, options.email),
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.void));
});

/**
 * Bind IAM (+ optional env) onto the ambient GCP host at deploy time.
 * No-op inside the deployed runtime (`__ALCHEMY_RUNTIME__`).
 */
export const bindGcpHost = (options: {
  tag: string;
  resource: { readonly LogicalId: string };
  iam: Input<GcpIamGrant>[];
  env?: Record<string, any>;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) return;
    const host = yield* Binding.Host;
    if (!isGcpHost(host)) return;
    yield* host.bind`Allow(${host}, ${options.tag}(${options.resource}))`({
      iam: options.iam,
      env: options.env,
    });
  }) as Effect.Effect<void>;
