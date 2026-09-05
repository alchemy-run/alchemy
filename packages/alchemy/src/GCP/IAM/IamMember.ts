import * as kms from "@distilled.cloud/gcp/cloudkms_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import type { ResourceClass, ResourceLike } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { CryptoKeyIamMember } from "./CryptoKeyIamMember.ts";
import type { ProjectIamMember } from "./ProjectIamMember.ts";
import type { SecretIamMember } from "./SecretIamMember.ts";
import type { ServiceAccountIamMember } from "./ServiceAccountIamMember.ts";

export type IamMemberProps = {
  /** IAM role to grant, such as `roles/artifactregistry.reader`. */
  role: string;
  /** IAM principal, such as `serviceAccount:name@project.iam.gserviceaccount.com`. */
  member: string;
};

export type IamMemberAttrs = {
  /** Resource whose IAM policy contains the grant. */
  resource: string;
  /** Granted IAM role. */
  role: string;
  /** Principal receiving the role. */
  member: string;
};

type Binding = { role?: string; members?: string[]; condition?: unknown };
type Policy = {
  bindings?: Binding[];
  etag?: string;
  version?: number;
  auditConfigs?: unknown[];
};

/**
 * Structural bound shared by every distilled IAM policy error
 * (`NotFound | Forbidden | BadRequest | Conflict | GcpOpError`). Every one
 * is a tagged `Error` subclass, so `_tag` and `message` are always present.
 */
type PolicyError = { readonly _tag: string; readonly message: string };

type PolicyAdapter<
  EGet extends PolicyError,
  ESet extends PolicyError,
  Req = never,
> = {
  get: (resource: string) => Effect.Effect<Policy, EGet, Req>;
  set: (resource: string, policy: Policy) => Effect.Effect<unknown, ESet, Req>;
};

const hasMember = (policy: Policy, role: string, member: string) =>
  (policy.bindings ?? []).some(
    (binding) =>
      binding.role === role &&
      binding.condition === undefined &&
      (binding.members ?? []).includes(member),
  );

/** @internal */
export const applyIamMemberChange = (
  policy: Policy,
  role: string,
  member: string,
  action: "add" | "remove",
): Policy | undefined => {
  const bindings = (policy.bindings ?? []).map((binding) => ({
    ...binding,
    members: [...(binding.members ?? [])],
  }));
  const binding = bindings.find(
    (candidate) => candidate.role === role && candidate.condition === undefined,
  );
  if (action === "add") {
    if (binding?.members?.includes(member)) return undefined;
    if (binding === undefined) bindings.push({ role, members: [member] });
    else binding.members = [...(binding.members ?? []), member];
  } else {
    if (binding === undefined || !binding.members?.includes(member)) {
      return undefined;
    }
    binding.members = binding.members.filter(
      (candidate) => candidate !== member,
    );
  }
  return {
    ...policy,
    bindings: bindings.filter(
      (candidate) => (candidate.members?.length ?? 0) > 0,
    ),
  };
};

/**
 * One in-process lock per policy resource. Concurrent `IamMember` rows on
 * the same project/secret/key otherwise interleave their read-modify-write
 * cycles and lose every grant but the last (or spin on etag conflicts).
 *
 * Caveat: in-process only; the `Conflict` retry below still covers
 * cross-process races.
 */
const policyLocks = new Map<string, Semaphore.Semaphore>();
const lockFor = (resource: string) => {
  let lock = policyLocks.get(resource);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    policyLocks.set(resource, lock);
  }
  return lock;
};

/**
 * IAM is eventually consistent: a principal (or the policy resource itself)
 * created seconds ago is briefly invisible, and `setIamPolicy` rejects with
 * `INVALID_ARGUMENT` ("Service account ... does not exist") or the
 * `getIamPolicy` call 404s.
 */
const notPropagated = (error: PolicyError) =>
  (error._tag === "BadRequest" || error._tag === "NotFound") &&
  /does not exist|was not found|not found/i.test(error.message);

const updatePolicy = <EGet extends PolicyError, ESet extends PolicyError, Req>(
  adapter: PolicyAdapter<EGet, ESet, Req>,
  resource: string,
  mutate: (policy: Policy) => Policy | undefined,
  // Propagation is only retried while granting: a missing resource during a
  // revoke means the grant is already gone, and the caller handles NotFound.
  retryPropagation: boolean,
) => {
  const attempt = Effect.retry(
    Effect.gen(function* () {
      const policy = yield* adapter.get(resource);
      const updated = mutate(policy);
      if (updated === undefined) return;
      yield* adapter.set(resource, updated);
    }),
    {
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.exponential("100 millis"),
    },
  );
  return lockFor(resource).withPermit(
    retryPropagation
      ? Effect.retry(attempt, {
          while: notPropagated,
          times: 10,
          schedule: Schedule.spaced("3 seconds"),
        })
      : attempt,
  );
};

const updateMember = <EGet extends PolicyError, ESet extends PolicyError, Req>(
  adapter: PolicyAdapter<EGet, ESet, Req>,
  resource: string,
  role: string,
  member: string,
  action: "add" | "remove",
) =>
  updatePolicy(
    adapter,
    resource,
    (policy) => applyIamMemberChange(policy, role, member, action),
    action === "add",
  );

const projectAdapter = {
  get: (resource: string) =>
    resourcemanager.getIamPolicyProjects({
      resource,
      body: { options: { requestedPolicyVersion: 3 } },
    }),
  set: (resource: string, policy: Policy) =>
    resourcemanager.setIamPolicyProjects({
      resource,
      body: { policy: policy as resourcemanager.Policy },
    }),
};
const serviceAccountAdapter = {
  get: (resource: string) =>
    iam.getIamPolicyProjectsServiceAccounts({
      resource,
      "options.requestedPolicyVersion": 3,
    }),
  set: (resource: string, policy: Policy) =>
    iam.setIamPolicyProjectsServiceAccounts({
      resource,
      body: { policy: policy as iam.Policy },
    }),
};
const cryptoKeyAdapter = {
  get: (resource: string) =>
    kms.getIamPolicyProjectsLocationsKeyRingsCryptoKeys({
      resource,
      "options.requestedPolicyVersion": 3,
    }),
  set: (resource: string, policy: Policy) =>
    kms.setIamPolicyProjectsLocationsKeyRingsCryptoKeys({
      resource,
      body: { policy: policy as kms.Policy },
    }),
};
const secretAdapter = {
  get: (resource: string) =>
    secretmanager.getIamPolicyProjectsSecrets({
      resource,
      "options.requestedPolicyVersion": 3,
    }),
  set: (resource: string, policy: Policy) =>
    secretmanager.setIamPolicyProjectsSecrets({
      resource,
      body: { policy: policy as secretmanager.Policy },
    }),
};

const normalizeProject = (project: string) =>
  project.startsWith("projects/") ? project : `projects/${project}`;
const normalizeServiceAccount = (value: string) =>
  value.startsWith("projects/") ? value : `projects/-/serviceAccounts/${value}`;

/**
 * Grant several roles to one principal on a project in a single
 * read-modify-write, through the same lock/retry path `ProjectIamMember`
 * uses. Empty `roles` is a no-op.
 */
export const grantProjectMembers = (
  project: string,
  member: string,
  roles: readonly string[],
) => {
  const unique = [...new Set(roles.filter((role) => role.length > 0))];
  if (unique.length === 0) return Effect.void;
  return updatePolicy(
    projectAdapter,
    normalizeProject(project),
    (policy) => {
      let next: Policy | undefined;
      for (const role of unique) {
        next =
          applyIamMemberChange(next ?? policy, role, member, "add") ?? next;
      }
      return next;
    },
    true,
  );
};

const memberProvider = <
  R extends ResourceLike<string, IamMemberProps, IamMemberAttrs>,
  EGet extends PolicyError,
  ESet extends PolicyError,
  Req,
>(
  resourceType: ResourceClass<R>,
  adapter: PolicyAdapter<EGet, ESet, Req>,
  target: (props: R["Props"], project: string) => string,
) => {
  // `Provider`'s `Props<Res>` is a conditional type that only resolves for a
  // concrete resource; for the generic `R` it stays deferred, so narrow the
  // engine-supplied props back to `R["Props"]` in one place.
  const propsOf = (props: R["Props"] | undefined) => props as R["Props"];
  return Provider.succeed(resourceType, {
    stables: [],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const props = propsOf(news);
      const next = target(props, env.project);
      if (
        output !== undefined &&
        (next !== output.resource ||
          props.role !== output.role ||
          props.member !== output.member)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      if (
        olds !== undefined &&
        (next !== target(propsOf(olds), env.project) ||
          props.role !== olds.role ||
          props.member !== olds.member)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const resource =
        output?.resource ??
        (olds === undefined ? undefined : target(propsOf(olds), env.project));
      const props = output ?? olds;
      if (resource === undefined || props === undefined) return undefined;
      const policy = yield* adapter.get(resource).pipe(
        Effect.catchIf(
          (error) => error._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      );
      if (policy === undefined) return undefined;
      if (!hasMember(policy, props.role, props.member)) return undefined;
      // A policy binding carries no ownership marker, so an existing grant is
      // reported as ours: the engine's interrupted-create recovery relies on
      // plain attrs to delete what it provisioned (see AdoptPolicy).
      return { resource, role: props.role, member: props.member };
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* GcpEnvironment.current;
      const props = propsOf(news);
      const resource = target(props, env.project);
      yield* updateMember(adapter, resource, props.role, props.member, "add");
      return { resource, role: props.role, member: props.member };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* Effect.catchIf(
        updateMember(
          adapter,
          output.resource,
          output.role,
          output.member,
          "remove",
        ),
        (error) => error._tag === "NotFound",
        () => Effect.void,
      );
    }),
  });
};

export const projectIamMemberProvider = (
  resource: ResourceClass<ProjectIamMember>,
) =>
  memberProvider(resource, projectAdapter, (props, project) =>
    normalizeProject(props.project ?? project),
  );
export const serviceAccountIamMemberProvider = (
  resource: ResourceClass<ServiceAccountIamMember>,
) =>
  memberProvider(resource, serviceAccountAdapter, (props) =>
    normalizeServiceAccount(props.serviceAccount),
  );
export const cryptoKeyIamMemberProvider = (
  resource: ResourceClass<CryptoKeyIamMember>,
) => memberProvider(resource, cryptoKeyAdapter, (props) => props.cryptoKey);
export const secretIamMemberProvider = (
  resource: ResourceClass<SecretIamMember>,
) => memberProvider(resource, secretAdapter, (props) => props.secret);
