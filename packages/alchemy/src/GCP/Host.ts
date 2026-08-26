import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Effect from "effect/Effect";
import * as Binding from "../Binding.ts";
import {
  Resource,
  type ResourceBinding,
  type ResourceLike,
} from "../Resource.ts";

/**
 * IAM grant attached to a GCP runtime host (Cloud Run Service/Job or
 * Cloud Function) the way AWS bindings attach `policyStatements` and
 * Cloudflare HTTP bindings mint a scoped `AccountApiToken`.
 */
export type GcpIamGrant = {
  /**
   * Predefined or custom role, e.g. `roles/redis.editor` or
   * `roles/aiplatform.user`.
   */
  role: string;
  /**
   * Resource to bind the role on. Project-level
   * (`projects/{project}`) when omitted.
   */
  resource?: string;
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

const GCP_HOST_TYPES = new Set([
  "GCP.Run.Service",
  "GCP.Run.Job",
  "GCP.Run.WorkerPool",
  "GCP.CloudFunctions.Function",
]);

/**
 * Default IAM role for a binding tag (`GCP.KMS.Decrypt` → KMS).
 * Bindings may override with an explicit `role`.
 */
const ROLE_BY_SERVICE: Record<string, string> = {
  aiplatform: "roles/aiplatform.user",
  alloydb: "roles/alloydb.client",
  apikeys: "roles/serviceusage.apiKeysViewer",
  artifactregistry: "roles/artifactregistry.reader",
  bigquery: "roles/bigquery.user",
  bigqueryconnection: "roles/bigquery.connectionUser",
  bigquerydatatransfer: "roles/bigquery.admin",
  bigtable: "roles/bigtable.user",
  binaryauthorization: "roles/binaryauthorization.attestorsViewer",
  cloudbuild: "roles/cloudbuild.builds.editor",
  cloudfunctions: "roles/cloudfunctions.developer",
  cloudscheduler: "roles/cloudscheduler.jobRunner",
  cloudtasks: "roles/cloudtasks.enqueuer",
  composer: "roles/composer.user",
  compute: "roles/compute.instanceAdmin.v1",
  connectors: "roles/connectors.viewer",
  container: "roles/container.developer",
  containeranalysis: "roles/containeranalysis.occurrences.viewer",
  contentwarehouse: "roles/contentwarehouse.documentAdmin",
  datapipelines: "roles/datapipelines.viewer",
  dataproc: "roles/dataproc.editor",
  datastore: "roles/datastore.user",
  documentai: "roles/documentai.apiUser",
  drive: "roles/drive.readonly",
  filestore: "roles/file.editor",
  firebaseappcheck: "roles/firebaseappcheck.admin",
  firebasedataconnect: "roles/firebasedataconnect.cloudSqlClient",
  firebaserules: "roles/firebaserules.system",
  firestore: "roles/datastore.user",
  kms: "roles/cloudkms.cryptoOperator",
  licensing: "roles/licensing.user",
  managedkafka: "roles/managedkafka.client",
  memcache: "roles/memcache.editor",
  ml: "roles/ml.developer",
  oracledatabase: "roles/oracledatabase.admin",
  parametermanager: "roles/parametermanager.parameterAccessor",
  privateca: "roles/privateca.certificateManager",
  pubsub: "roles/pubsub.editor",
  pubsublite: "roles/pubsublite.publisher",
  recaptchaenterprise: "roles/recaptchaenterprise.agent",
  redis: "roles/redis.editor",
  retail: "roles/retail.admin",
  run: "roles/run.developer",
  secretmanager: "roles/secretmanager.secretAccessor",
  servicedirectory: "roles/servicedirectory.editor",
  spanner: "roles/spanner.databaseUser",
  speech: "roles/speech.client",
  sql: "roles/cloudsql.client",
  storage: "roles/storage.objectAdmin",
  storagetransfer: "roles/storagetransfer.user",
  tpu: "roles/tpu.admin",
  translate: "roles/cloudtranslate.user",
  transcoder: "roles/transcoder.admin",
  workflows: "roles/workflows.invoker",
  workstations: "roles/workstations.user",
};

export const defaultRoleFor = (tag: string): string => {
  const service = tag.split(".")[1]?.toLowerCase() ?? "";
  return ROLE_BY_SERVICE[service] ?? "roles/viewer";
};

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

export const collectHostBindings = (
  bindings: readonly (ResourceBinding<GcpHostBinding> & {
    action?: string;
  })[],
): { env: Record<string, any>; iam: GcpIamGrant[] } => {
  const active = bindings.filter((binding) => binding.action !== "delete");
  const env = active
    .map((binding) => binding.data?.env)
    .reduce<Record<string, any>>((acc, next) => ({ ...acc, ...next }), {});
  const iam = active.flatMap((binding) => binding.data?.iam ?? []);
  return { env, iam };
};

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

const memberOf = (email: string) =>
  email.startsWith("serviceAccount:") ? email : `serviceAccount:${email}`;

/**
 * Grant `roles` to `member` on the GCP project (read-modify-write of
 * `projects.setIamPolicy`). Empty `roles` is a no-op.
 */
export const grantProjectIam = (
  project: string,
  member: string,
  roles: readonly string[],
) => {
  const unique = [...new Set(roles.filter((role) => role.length > 0))];
  if (unique.length === 0) return Effect.void;
  const principal = memberOf(member);
  const resource = `projects/${project}`;
  return Effect.gen(function* () {
    const policy = yield* resourcemanager.getIamPolicyProjects({ resource });
    const bindings = [...(policy.bindings ?? [])];
    let dirty = false;
    for (const role of unique) {
      const existing = bindings.find((binding) => binding.role === role);
      if (existing === undefined) {
        bindings.push({ role, members: [principal] });
        dirty = true;
        continue;
      }
      const members = existing.members ?? [];
      if (!members.includes(principal)) {
        existing.members = [...members, principal];
        dirty = true;
      }
    }
    if (!dirty) return;
    yield* resourcemanager.setIamPolicyProjects({
      resource,
      body: {
        policy: {
          ...policy,
          bindings,
        },
      },
    });
  });
};

/**
 * Apply collected host bindings: merge env, grant IAM to the runtime
 * service account.
 */
export const applyHostBindings = Effect.fn(function* (options: {
  project: string;
  serviceAccount: string;
  bindings: readonly ResourceBinding<GcpHostBinding>[];
}) {
  const collected = collectHostBindings(options.bindings);
  yield* grantProjectIam(
    options.project,
    options.serviceAccount,
    collected.iam.map((grant) => grant.role),
  );
  return collected;
});

/**
 * Bind IAM (+ optional env) onto the ambient GCP host at deploy time.
 * No-op inside the deployed runtime (`__ALCHEMY_RUNTIME__`).
 */
export const bindGcpHost = (options: {
  tag: string;
  resource: { readonly LogicalId: string };
  iam: GcpIamGrant[];
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
