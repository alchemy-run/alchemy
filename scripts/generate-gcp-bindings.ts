/**
 * Generate GCP bindings: one `Binding.Service` + `<Op>Http.ts` layer per
 * discovery method that runs against a resource Alchemy manages.
 *
 *   node scripts/generate-gcp-bindings.ts                 # every configured service
 *   node scripts/generate-gcp-bindings.ts PubSub          # one service
 *   node scripts/generate-gcp-bindings.ts --report PubSub # classify only, write nothing
 *   node scripts/generate-gcp-bindings.ts --check         # fail if any generated file is stale
 *
 * Inputs, per service, in `packages/gcp/bindings/`:
 *
 * - `<Service>.json`: the discovery doc and distilled module, the service's
 *   resources (full-name pattern and IAM kind), and overrides for what can't
 *   be derived (permissions, names, skips with a reason).
 * - `roles.json`: permission → the role a binding grants for it. Refresh
 *   with `node scripts/generate-gcp-bindings.ts --refresh-roles` (needs
 *   gcloud); see {@link pickRole} for the choice.
 *
 * Each discovery method is classified:
 *
 * - `internal`: long-running operation polling, IAM policy methods, and
 *   location metadata;
 * - `lifecycle`: create/delete/patch/update of a configured resource itself,
 *   which its provider owns;
 * - `covered`: already implemented by a hand-written binding in the service;
 * - `project`: targets the project or a location, not a resource Alchemy
 *   manages (reported; not generated yet);
 * - `needs-permission`: no permission could be derived or found in
 *   `roles.json` (add a `permissions` override);
 * - `binding`: generated.
 *
 * Methods that differ only by a `locations` segment (`projects.secrets.get`
 * and `projects.locations.secrets.get`) become one binding with a variant
 * per resource type.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Argument, Command, Flag } from "effect/cli";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";

// ============ Config ============

interface ResourceConfig {
  /** Full-name pattern, e.g. `projects/*\/topics/*`. */
  pattern: string;
  /** `GcpIamResourceKind` of the resource's own IAM policy; omit for project-level grants. */
  iamKind?: string;
  /**
   * Without a resource IAM policy, grant on the project under an IAM
   * Condition matching only the bound resource and its children
   * (Firestore databases).
   */
  scopeByCondition?: boolean;
  /** Resource type when it isn't `GCP.<Service>.<key>`. */
  type?: string;
  /**
   * Only marks create/patch/update/delete on this resource as its provider's
   * lifecycle; other methods bind through the parent resource. For child
   * resources with no IAM policy of their own (Spanner backup schedules).
   */
  lifecycleOnly?: boolean;
  /**
   * For APIs that address resources by separate path parameters
   * (`projects/{projectId}/datasets/{datasetId}`) instead of one name: the
   * resource attribute that fills each `*` in `pattern`, in order. The
   * binding fills those parameters; any further ones stay request fields.
   */
  attributes?: string[];
  /**
   * Attribute holding the name IAM grants target, when it isn't `name`:
   * a Cloud Storage bucket is named by `bucketName`.
   */
  nameAttribute?: string;
  /**
   * Request fields (other than path parameters) the binding fills from the
   * bound resource's attributes when the method takes them: a BigQuery job
   * is read in its `location`.
   */
  fields?: Record<string, string>;
  /**
   * The resource's name in audit logs, from one attribute, when it isn't
   * `name`: `projects/_/buckets/{bucketName}`.
   */
  auditName?: string;
  /**
   * The resource's TypeScript type when it isn't the key: Compute names the
   * `HttpsHealthCheck` resource's type `HttpsHealthCheckResource`.
   */
  typeName?: string;
  /** The module defining the resource when it isn't `<key>.ts` (Datastore's `Indexes.ts`). */
  file?: string;
  /** Why the resource gets no `consume<Resource>AuditLogs` source. */
  noAuditLogs?: string;
  /**
   * The discovery collection whose methods manage this resource, when it
   * isn't the pattern's last collection: `regionDisks` for
   * `projects/*\/regions/*\/disks/*`, `buckets` for `b/*`.
   */
  collection?: string;
}

interface ApiConfig {
  /** Discovery doc in distilled's spec mirror, e.g. `pubsub-v1`. */
  discovery: string;
  /** Distilled module, e.g. `pubsub_v1`. */
  module: string;
  /** Distilled import path segment; `unstable/` for unstable services. */
  unstable?: boolean;
  /**
   * Prefix of the API's IAM permissions when it isn't the discovery name:
   * `workflowexecutions` methods check `workflows.*` permissions.
   */
  permissionService?: string;
}

interface ServiceConfig extends Partial<ApiConfig> {
  /** More discovery docs whose methods bind to this service's resources. */
  apis?: ApiConfig[];
  /**
   * `serviceName`s the service's audit log entries carry, when they aren't
   * just the discovery docs' hosts (Bigtable data calls log as
   * `bigtable.googleapis.com`, admin calls as `bigtableadmin.googleapis.com`).
   */
  auditServices?: string[];
  resources: Record<string, ResourceConfig>;
  /** Method id → IAM permission. */
  permissions?: Record<string, string>;
  /**
   * Permission (or method id) → role, where `roles.json`'s smallest role is
   * a poor fit: `artifactregistry.repositories.get` is smallest in a
   * migration role that also reads Cloud Storage, and copying an object
   * needs `storage.objects.get` on the source besides `create`. A list
   * grants its first role as usual and the rest on the project, for calls
   * that also write somewhere else (a de-identify fills a new dataset).
   */
  roles?: Record<string, string | string[]>;
  /** Derived binding name → name to use. */
  names?: Record<string, string>;
  /** Method id → reason it is not a binding. */
  skip?: Record<string, string>;
  /**
   * Method id → a fixed path appended to the bound resource's name, for
   * targets that aren't a child resource: Firestore queries run on
   * `projects/p/databases/d/documents`.
   */
  append?: Record<string, string>;
  /**
   * Method id → `[separator, field]` appended to the target name, for
   * targets like `projects/p/schemas/s@<revisionId>`.
   */
  suffix?: Record<string, [string, string]>;
  /**
   * Child collection → the request field naming its member, when the
   * collection's singular isn't a good name: FHIR's `fhir/{type}` →
   * `resourceType`.
   */
  childFields?: Record<string, string>;
  /**
   * Method id → the attribute of the bound resource naming what the
   * permission is checked on, and that resource's IAM kind:
   * `{ "attribute": "topic", "iamKind": "pubsub.topic" }`.
   */
  grantOn?: Record<string, { attribute: string; iamKind?: string }>;
  /**
   * Method id → why the permission is only honoured on the project (it goes
   * into the binding's JSDoc). The role is granted on the project instead
   * of the bound resource.
   */
  projectGrant?: Record<string, string>;
  /**
   * Method ids that are calls on the project even though they create a
   * configured resource's kind: `jobs.insert` starts a load or extract job
   * at runtime, while the `Job` resource is a job run at deploy.
   */
  projectCalls?: string[];
  /** Don't generate bindings for calls on the project itself (`topics.list`). */
  noProjectBindings?: boolean;
  /**
   * Discovery collection → the collection its IAM permissions are named
   * after: Compute checks `regionDisks.resize` as `compute.disks.resize`.
   */
  permissionCollections?: Record<string, string>;
  /**
   * Method verb → the verb its IAM permission is named after, for APIs that
   * check many verbs as one: Compute checks `instanceGroupManagers.resize`
   * as `compute.instanceGroupManagers.update`.
   */
  verbPermissions?: Record<string, string>;
  /**
   * The permission a method checks when no other resolves: APIs that bill a
   * project but check no IAM permission of their own (Vision, Speech) need
   * only `serviceusage.services.use`.
   */
  defaultPermission?: string;
  /**
   * Live probes: when set, the generator also writes a Cloud Run host that
   * calls every binding (`test/GCP/<Service>/fixtures/generated-host.ts`)
   * and a test per binding (`test/GCP/<Service>/Generated.test.ts`).
   */
  probes?: ProbeConfig;
}

interface ProbeConfig {
  /**
   * Resource key → the export of `fixtures/generated-resources.ts` that
   * deploys one for the probes to bind.
   */
  resources: Record<string, string>;
  /**
   * Resource key → why its bindings can't run live (each becomes a
   * `test.skip`). `"project"` covers the project-scoped bindings, `"*"`
   * every binding of the service.
   */
  untestable?: Record<string, string>;
  /**
   * APIs the probe stack enables before its host deploys, for services the
   * testing project doesn't enable by default (`appengine.googleapis.com`).
   * They stay enabled on destroy: other stacks may use them.
   */
  enable?: string[];
  /** Binding name → the request it is called with, replacing the placeholder. */
  args?: Record<string, string>;
  /** Binding name → why it isn't called (a `test.skip`). */
  skip?: Record<string, string>;
  /** The location probes call in, when the service has no `us-central1` (API Keys: `global`). */
  location?: string;
  /** Binding name → the location its probe calls in, when it differs from {@link location}. */
  locations?: Record<string, string>;
  /**
   * The suite that already calls every resource-bound binding live
   * (`Bindings.test.ts`): the generated suite then probes only the
   * project-scoped ones.
   */
  coveredBy?: string;
  /**
   * Error tag → why a plain read may answer it on the testing project
   * instead of succeeding (`ApiHubNotProvisioned`: no API hub instance).
   * The call is still authorized.
   */
  allowedOutcomes?: Record<string, string>;
  /**
   * Error tag → why it is ambiguous: an API that answers a missing resource
   * and a denied permission alike (BigLake's 403 "denied (or it may not
   * exist)"). Probes retry it while a fresh grant propagates, then accept it.
   */
  ambiguousTags?: Record<string, string>;
  /**
   * VPC networks the probe resources create (Private Service Access, an
   * internal load balancer): the suite holds that many quota slots from
   * deploy to destroy (`test/GCP/networkQuota.ts`).
   */
  networks?: number;
  /**
   * Minutes the probe stack may take to deploy or destroy, when a resource
   * provisions for longer than the default 30 (Managed Microsoft AD).
   */
  deployMinutes?: number;
}

// ============ Discovery ============

interface DiscoveryMethod {
  id: string;
  path: string;
  description?: string;
  parameters?: Record<string, { pattern?: string; location?: string }>;
}

interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

const collectMethods = (
  resource: DiscoveryResource,
  path: string[],
  out: { method: DiscoveryMethod; name: string; path: string[] }[],
) => {
  for (const [name, method] of Object.entries(resource.methods ?? {})) {
    out.push({ method, name, path });
  }
  for (const [name, child] of Object.entries(resource.resources ?? {})) {
    collectMethods(child, [...path, name], out);
  }
  return out;
};

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const safeIdentifier = (s: string) => s.replace(/[^a-zA-Z0-9_$]/g, "_");

/** Distilled's operation name: `<method><Resource…>` (see distilled's convert.ts). */
const functionName = (name: string, path: string[]) =>
  safeIdentifier(name) + path.map((r) => capitalize(safeIdentifier(r))).join("");

/** `^projects/[^/]+/topics/[^/]+$` → `["projects", "*", "topics", "*"]`. */
const patternSegments = (pattern: string): string[] | undefined => {
  const body = pattern
    .replace(/^\^/, "")
    .replace(/\$$/, "")
    .replaceAll("[^/]+", "*")
    .replace(/\.\*$/, "*");
  const segments = body.split("/");
  return segments.every((s) => s === "*" || /^[a-zA-Z][a-zA-Z0-9]*$/.test(s))
    ? segments
    : undefined;
};

const singular = (word: string) =>
  /series$/i.test(word)
    ? word
    : word.endsWith("aches")
      ? word.slice(0, -1)
      : word.endsWith("ies")
        ? `${word.slice(0, -3)}y`
        : word.endsWith("sses") || word.endsWith("xes") || word.endsWith("ches")
          ? word.slice(0, -2)
          : word.endsWith("s") && !word.endsWith("ss")
            ? word.slice(0, -1)
            : word;

/**
 * A path with one parameter per segment, e.g.
 * `projects/{+projectId}/datasets/{+datasetId}/tables/{+tableId}/insertAll`
 * → segments `projects/*\/datasets/*\/tables/*` and the parameter of each `*`.
 * Trailing literal segments and `:verb` suffixes name the action, not the target.
 */
const flatTarget = (path: string) => {
  // A leading service name and version (`dns/v1/projects/{project}`) aren't
  // part of the target.
  const all = path.replace(/:[A-Za-z]+$/, "").split("/");
  const projects = all.indexOf("projects");
  const leading = projects > 0 ? all.slice(0, projects) : [];
  const parts =
    leading.length > 0 && leading.every((part) => /^[a-z][a-z0-9]*$/.test(part))
      ? all.slice(projects)
      : all.filter((part, i) => i !== 0 || !/^v\d+((alpha|beta)\d*)?$/.test(part));
  const segments: string[] = [];
  const params: string[] = [];
  for (const part of parts) {
    const param = /^\{\+?(\w+)\}$/.exec(part)?.[1];
    if (param) {
      segments.push("*");
      params.push(param);
    } else if (/^[a-zA-Z][a-zA-Z0-9]*$/.test(part)) segments.push(part);
    else return undefined;
  }
  while (segments.length > 0 && segments.at(-1) !== "*") segments.pop();
  return segments.length > 0 ? { param: undefined, segments, params } : undefined;
};

const SCOPE_COLLECTIONS = new Set(["projects", "locations", "organizations", "folders"]);
const LIFECYCLE_VERBS = new Set(["create", "delete", "patch", "update"]);
const IAM_VERBS = new Set(["getIamPolicy", "setIamPolicy", "testIamPermissions"]);

// ============ Distilled module ============

interface OperationTypes {
  request: string;
  response: string;
  error: string;
}

const parseOperation = (source: string, fn: string): OperationTypes | undefined => {
  const match = new RegExp(
    `export const ${fn}: API\\.(?:Paginated)?OperationMethod<\\s*(\\w+),\\s*(\\w+),\\s*(\\w+),`,
  ).exec(source);
  return match ? { request: match[1]!, response: match[2]!, error: match[3]! } : undefined;
};

/** Required member names of an interface in the distilled module. */
const requiredMembers = (source: string, name: string): string[] => {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) return [];
  const end = source.indexOf("\n}", start);
  return [...source.slice(start, end).matchAll(/^ {2}"?([\w.$]+)"?: /gm)].map((m) => m[1]!);
};

/** The text of an interface declaration, or "" when it isn't there. */
const interfaceBody = (source: string, name: string) => {
  const start = source.indexOf(`export interface ${name} {`);
  return start === -1 ? "" : source.slice(start, source.indexOf("\n}", start));
};

/** Required members of a request interface with their declared types. */
const requiredFieldTypes = (source: string, name: string): [string, string][] => {
  const start = source.indexOf(`export interface ${name} {`);
  if (start === -1) return [];
  const end = source.indexOf("\n}", start);
  return [...source.slice(start, end).matchAll(/^ {2}"?([\w.$]+)"?: ([^;]+);/gm)].map((m) => [
    m[1]!,
    m[2]!.trim(),
  ]);
};

/**
 * Request fields a name-style binding fills from the bound resource besides
 * its name: a Storage Transfer job is addressed `transferJobs/{id}` with the
 * project in `projectId`.
 */
const nameStyleFields = (resource: object, method: DiscoveryMethod) => {
  const fields = "fields" in resource ? (resource.fields as Record<string, string>) : undefined;
  const filled = Object.entries(fields ?? {}).filter(
    ([field]) => method.parameters?.[field] !== undefined,
  );
  return filled.length ? Object.fromEntries(filled) : undefined;
};

/** Children the request names (a trailing singleton segment has no field). */
const childFieldsOf = (variant: { children: [string, string][] }) =>
  variant.children.filter(([, field]) => field !== "");

// ============ Classification ============

interface Variant {
  resource: string; // config key
  api: Api;
  methodId: string;
  fn: string;
  /** Request field the target's full name goes in (name-style APIs). */
  param: string | undefined;
  /** Request field → resource attribute (flat-path APIs). */
  params: Record<string, string> | undefined;
  /** A call on the project or one of its locations: no resource to bind. */
  scope: "project" | "location" | undefined;
  /** Flat-path project-scoped calls: the project-id request field. */
  projectField: string | undefined;
  children: [string, string][];
  suffix?: [string, string];
  append?: string;
  grantOn?: { attribute: string; iamKind?: string };
  projectGrant?: string;
  permission: string;
  role: string;
  /** More roles granted on the project alongside `role`. */
  also: string[];
  types: OperationTypes;
}

interface Binding {
  name: string;
  verb: string;
  description: string;
  variants: Variant[];
}

interface Classified {
  id: string;
  kind: "internal" | "lifecycle" | "covered" | "project" | "needs-permission" | "skip" | "binding";
  reason?: string;
}

interface Api extends ApiConfig {
  /** Import alias, e.g. `pubsub`. */
  ns: string;
  importPath: string;
  doc: DiscoveryResource & { name: string; rootUrl: string };
  moduleSource: string;
}

const classify = (options: {
  config: ServiceConfig;
  api: Api;
  covered: Set<string>;
  roles: Record<string, string>;
  bindings: Map<string, Binding>;
}) => {
  const { config, api, covered, bindings } = options;
  const roles = { ...options.roles, ...config.roles };
  // IAM spells a collection its own way (`goldenGateDeployments` for
  // `goldengateDeployments`, `notificationconfig` for `notificationConfigs`):
  // match permissions ignoring case and a plural `s`.
  const fold = (permission: string) =>
    permission
      .split(".")
      .map((part, i, all) =>
        i === all.length - 2 ? part.toLowerCase().replace(/s$/, "") : part.toLowerCase(),
      )
      .join(".");
  const folded = new Map(Object.keys(roles).map((p) => [fold(p), p]));
  const known = (permission: string) =>
    roles[permission] !== undefined ? permission : folded.get(fold(permission));
  const { doc, moduleSource } = api;
  const permissionService = api.permissionService ?? doc.name;
  const resources = Object.entries(config.resources).map(([key, value]) => ({
    key,
    ...value,
    segments: value.pattern.split("/"),
    collection: value.collection ?? value.pattern.split("/").at(-2),
  }));
  const results: Classified[] = [];
  const ownCollections = new Set(resources.map((r) => r.collection));
  // A call that names the project (`projects.images.annotate`) wins over its
  // global twin (`images.annotate`) when both map to one binding.
  // Collection + verb of every call that names something in its path: a
  // global call with such a twin (AI Platform's API-key `datasets.list`) is
  // an alternate entry point, not the project's.
  const scopedTwins = new Set(
    collectMethods(doc, [], [])
      .filter(({ method }) => method.path.includes("{"))
      .map(({ name, path }) => `${path.at(-1)}.${name}`),
  );
  const methods = collectMethods(doc, [], []).sort(
    (a, b) => Number(b.method.path.includes("{")) - Number(a.method.path.includes("{")),
  );
  // A method and its `locations` twin are one binding: if a hand-written
  // binding calls either, both are covered.
  const twinKey = (id: string) =>
    id
      .split(".")
      .filter((p) => p !== "locations")
      .join(".");
  const coveredKeys = new Set(
    methods
      .filter((m) => covered.has(functionName(m.name, m.path)))
      .map((m) => twinKey(m.method.id)),
  );

  for (const { method, name: verb, path } of methods) {
    const id = method.id;
    const parts = id.split(".");
    const cols = parts.slice(1, -1);
    if (config.skip?.[id]) {
      results.push({ id, kind: "skip", reason: config.skip[id] });
      continue;
    }
    if (cols.includes("operations") || IAM_VERBS.has(verb) || cols.at(-1) === "locations") {
      results.push({ id, kind: "internal" });
      continue;
    }
    const fn = functionName(verb, path);
    if (coveredKeys.has(twinKey(id))) {
      results.push({ id, kind: "covered" });
      continue;
    }
    // The path parameter that names the target (`{+name}`, `{+parent}`, `{+topic}`).
    const vars = [...method.path.matchAll(/\{\+?(\w+)\}/g)].map((m) => m[1]!);
    const targets = vars
      .map((v) => ({ param: v, segments: patternSegments(method.parameters?.[v]?.pattern ?? "") }))
      // `^[^/]+/[^/]+$` takes `projects/p`, `folders/f` or `organizations/o`:
      // bind its project form.
      .map((t) =>
        t.segments?.[0] === "*" && t.segments[1] === "*"
          ? { ...t, segments: ["projects", ...t.segments.slice(1)] }
          : t,
      )
      .filter((t): t is { param: string; segments: string[] } => t.segments !== undefined)
      // A full name has a collection in it; `^[^/]+$` is one segment of a flat path.
      .filter((t) => t.segments.length > 1);
    // Otherwise the method's own path, for APIs with one parameter per segment.
    const flat = flatTarget(method.path);
    // Or a call on the project named by a query parameter (`GET b?project=p`).
    const projectQuery =
      method.parameters?.project?.location === "query"
        ? { param: undefined, segments: ["projects", "*"], params: ["project"] }
        : undefined;
    // Or a global call with no path parameters (`images:annotate`): a
    // project-scoped binding that injects nothing; the call bills the
    // credentials' project.
    const global =
      vars.length === 0 &&
      !method.path.includes("locations/") &&
      !scopedTwins.has(`${cols.at(-1)}.${verb}`)
        ? { param: undefined, segments: ["projects", "*"], params: [] }
        : undefined;
    const target: { param: string | undefined; segments: string[]; params?: string[] } | undefined =
      targets.sort((a, b) => b.segments.length - a.segments.length)[0] ??
      flat ??
      projectQuery ??
      global;
    if (target === undefined) {
      results.push({
        id,
        kind: "project",
        reason: "its path names no project",
      });
      continue;
    }
    // `projects/{p}/locations/global` is a location like any other: the
    // caller passes `location: "global"`.
    if (
      target.segments.length === 4 &&
      target.segments[2] === "locations" &&
      target.segments[3] === "global"
    ) {
      target.segments = [...target.segments.slice(0, 3), "*"];
    }
    // A `/`-separated suffix is the target's last segment, filled from the
    // request (`fhir/{type}/{id}`): match the resource on the rest.
    if (config.suffix?.[id]?.[0] === "/") {
      target.segments = target.segments.slice(0, -1);
    }
    const lifecycleOnly = resources.find(
      (r) =>
        r.lifecycleOnly &&
        r.segments.length === target.segments.length &&
        r.segments.every((s, i) => s === target.segments[i]),
    );
    if (lifecycleOnly && LIFECYCLE_VERBS.has(verb)) {
      results.push({ id, kind: "lifecycle" });
      continue;
    }
    const matched = resources
      .filter(
        (r) =>
          !r.lifecycleOnly &&
          // A flat target only matches resources configured with `attributes`.
          (target.param === undefined) === (r.attributes !== undefined) &&
          r.segments.length <= target.segments.length &&
          r.segments.every((s, i) => s === target.segments[i]) &&
          // A flat target's further parameters are plain request fields
          // (`b/{bucket}/o/{sourceObject}/moveTo/o/{destinationObject}`).
          (target.param === undefined ||
            config.append?.[id] !== undefined ||
            (target.segments.length - r.segments.length) % 2 === 0),
      )
      .sort((a, b) => b.segments.length - a.segments.length)[0];
    const projectCall = config.projectCalls?.includes(id) ?? false;
    const created =
      !projectCall &&
      (verb === "create" || verb === "insert") &&
      resources.some((r) => r.collection === cols.at(-1));
    // Nothing to bind to: a call on the project (or one of its locations)
    // itself becomes a project-scoped binding.
    const scope =
      (matched !== undefined && !projectCall) || created
        ? undefined
        : target.segments.join("/") === "projects/*" ||
            // A flat path's further parameters (zone, region, a catalog
            // entry like a disk type) are request fields.
            (target.param === undefined && target.segments.join("/").startsWith("projects/*/"))
          ? ("project" as const)
          : target.param !== undefined && target.segments.join("/") === "projects/*/locations/*"
            ? ("location" as const)
            : undefined;
    // A resource Alchemy doesn't manage (a Redis cluster, a backup) under the
    // project or one of its locations: a project-scoped binding whose
    // request names it, `{ location, cluster }` → `…/clusters/{cluster}`.
    const unmanaged =
      scope === undefined && matched === undefined && !created && target.param !== undefined
        ? target.segments[0] === "projects" &&
          target.segments[1] === "*" &&
          target.segments[2] === "locations" &&
          target.segments[3] === "*"
          ? { scope: "location" as const, prefix: target.segments.slice(0, 4) }
          : target.segments[0] === "projects" && target.segments[1] === "*"
            ? { scope: "project" as const, prefix: target.segments.slice(0, 2) }
            : undefined
        : undefined;
    const unmanagedRest = unmanaged ? target.segments.slice(unmanaged.prefix.length) : [];
    const unmanagedOk =
      unmanaged !== undefined &&
      unmanagedRest.length > 0 &&
      // Collection/id pairs, optionally ending in a singleton
      // (`clusters/*/certificateAuthority`).
      unmanagedRest.every((s, i) => (i % 2 === 1) === (s === "*"));
    const resource =
      (projectCall ? undefined : matched) ??
      (scope !== undefined && !config.noProjectBindings
        ? {
            key: `@${scope}`,
            pattern: target.segments.join("/"),
            segments: target.segments,
          }
        : unmanagedOk && !config.noProjectBindings
          ? {
              key: `@${unmanaged!.scope}`,
              pattern: unmanaged!.prefix.join("/"),
              segments: unmanaged!.prefix,
            }
          : undefined);
    const effectiveScope = scope ?? (unmanagedOk ? unmanaged!.scope : undefined);
    if (resource === undefined) {
      results.push(
        created
          ? { id, kind: "lifecycle" }
          : {
              id,
              kind: "project",
              reason:
                target.segments[0] !== "projects"
                  ? `addressed under \`${target.segments[0]}/\`, not a project`
                  : `\`${target.segments.join("/")}\` has no Alchemy resource to bind`,
            },
      );
      continue;
    }
    const extra = config.append?.[id] ? [] : target.segments.slice(resource.segments.length);
    // Name-style targets assemble child segments from request fields; a flat
    // target's further path parameters are already request fields.
    const children: [string, string][] = [];
    for (let i = 0; target.param !== undefined && i < extra.length; i += 2) {
      // A trailing singleton (`…/certificateAuthority`) is a fixed segment.
      children.push([
        extra[i]!,
        extra[i + 1] === undefined ? "" : (config.childFields?.[extra[i]!] ?? singular(extra[i]!)),
      ]);
    }
    // Flat target: the method parameter at each of the resource's wildcards,
    // filled from the matching attribute.
    const params: Record<string, string> | undefined =
      target.param === undefined && "attributes" in resource && resource.attributes
        ? Object.fromEntries([
            ...resource.attributes.map((attribute, i) => [target.params![i]!, attribute]),
            ...Object.entries(resource.fields ?? {}).filter(
              ([field]) => method.parameters?.[field] !== undefined,
            ),
          ])
        : nameStyleFields(resource, method);
    const ownCollection = "collection" in resource ? resource.collection : resource.segments.at(-2);
    if (
      (LIFECYCLE_VERBS.has(verb) && extra.length === 0 && cols.at(-1) === ownCollection) ||
      // Creating a child that is itself a configured resource is its provider's job.
      (!projectCall && (verb === "create" || verb === "insert") && ownCollections.has(cols.at(-1)))
    ) {
      results.push({ id, kind: "lifecycle" });
      continue;
    }
    // The method's own collection stays even when it shares a scope's name
    // (Cloud Storage `folders`).
    const scoped = cols.filter((c, i) => i === cols.length - 1 || !SCOPE_COLLECTIONS.has(c));
    const permission =
      config.permissions?.[id] ??
      [
        verb === "patch"
          ? "update"
          : verb === "insert"
            ? "create"
            : verb === "aggregatedList"
              ? "list"
              : verb,
        verb,
        ...(config.verbPermissions?.[verb] ? [config.verbPermissions[verb]] : []),
      ]
        // Only the method's own collection: a parent's permission
        // (`databases.create` for creating an index) is a different action.
        // Some services lowercase it (`artifactregistry.dockerimages.get`).
        .flatMap((v) =>
          scoped.length === 0
            ? []
            : [
                config.permissionCollections?.[scoped.at(-1)!] ?? scoped.at(-1)!,
                scoped.at(-1)!.toLowerCase(),
              ].map((c) => `${permissionService}.${c}.${v}`),
        )
        .map(known)
        .find((p) => p !== undefined) ??
      // No permission named after the verb: services check custom verbs and
      // child collections as a read (`get`) or a write (`update`) of the
      // collection or its parent. The live probes confirm the grant.
      [...scoped]
        .reverse()
        .filter((c): c is string => c !== undefined)
        .map(
          (c) =>
            `${permissionService}.${config.permissionCollections?.[c] ?? c}.${
              /^(get|list|search|fetch|lookup|query|batchGet|aggregatedList|access|summarize|check|validate|describe|view|preview|compute|retrieve|read|count)/.test(
                verb,
              )
                ? "get"
                : "update"
            }`,
        )
        .map(known)
        .find((p) => p !== undefined) ??
      config.defaultPermission;
    if (permission === undefined || roles[permission] === undefined) {
      results.push({ id, kind: "needs-permission", reason: permission });
      continue;
    }
    const types = parseOperation(moduleSource, fn);
    if (types === undefined) {
      // Patched out of distilled (a deprecated or broken method).
      results.push({ id, kind: "skip", reason: `no distilled operation ${fn}` });
      continue;
    }
    // `get` on [secrets, versions] → GetSecretVersion; `list` keeps the
    // plural. Nouns start at the bound resource's collection, and a noun the
    // next one repeats is dropped: [cryptoKeys, cryptoKeyVersions] →
    // CryptoKeyVersion. A multi-word verb gets the resource noun after its
    // first word unless it already names it: deleteRevision →
    // DeleteSchemaRevision, rotateSecret → RotateSecret.
    const words = verb.split(/(?=[A-Z])/);
    const named = scoped.slice(Math.max(0, scoped.indexOf(ownCollection!)));
    const nouns = named
      .map((c, i) =>
        verb === "list" && i === named.length - 1 ? capitalize(c) : capitalize(singular(c)),
      )
      .filter((n, i, all) => !(all[i + 1] ?? "").startsWith(n));
    const resourceNoun = capitalize(singular(scoped.at(-1) ?? ""));
    const derived =
      words.length === 1
        ? capitalize(verb) + nouns.join("")
        : verb.toLowerCase().includes(resourceNoun.toLowerCase())
          ? capitalize(verb)
          : capitalize(words[0]!) + resourceNoun + words.slice(1).join("");
    // Collections like `.well-known/openid-configuration` aren't identifiers.
    const name =
      config.names?.[derived] ??
      derived
        .split(/[^A-Za-z0-9]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("");
    const binding = bindings.get(name) ?? {
      name,
      verb,
      description: (method.description ?? "").split(/(?<=\.)\s/)[0] ?? "",
      variants: [],
    };
    if (
      binding.variants.some((v) => v.resource === resource.key) ||
      binding.variants.some((v) => (v.scope === undefined) !== (effectiveScope === undefined))
    ) {
      results.push({ id, kind: "project", reason: `name collision on ${name}` });
      continue;
    }
    binding.variants.push({
      resource: resource.key,
      api,
      methodId: id,
      fn,
      param: target.param,
      params,
      scope: effectiveScope,
      projectField:
        effectiveScope !== undefined && target.param === undefined ? target.params![0] : undefined,
      children,
      suffix: config.suffix?.[id],
      append: config.append?.[id],
      grantOn: config.grantOn?.[id],
      projectGrant: config.projectGrant?.[id],
      permission,
      ...(([role, ...also]) => ({ role: role!, also }))(
        [config.roles?.[id] ?? roles[permission]!].flat(),
      ),
      types,
    });
    bindings.set(name, binding);
    results.push({ id, kind: "binding" });
  }
  // The global variant first: it is the common case and the JSDoc example.
  for (const binding of bindings.values()) {
    binding.variants.sort(
      (a, b) =>
        Number(a.methodId.includes(".locations.")) - Number(b.methodId.includes(".locations.")),
    );
  }
  return results;
};

// ============ Emit ============

const HEADER = (service: string) =>
  `// @generated by scripts/generate-gcp-bindings.ts from packages/gcp/bindings/${service}.json. Do not edit.\n`;

const apiImports = (binding: Binding, type: boolean) =>
  [...new Map(binding.variants.map((v) => [v.api.ns, v.api.importPath])).entries()]
    .map(([ns, path]) => `import ${type ? "type " : ""}* as ${ns} from "${path}";`)
    .join("\n");

/** Where a variant's role is granted, for the binding's JSDoc. */
const grantScope = (config: ServiceConfig, variant: Variant) => {
  const resource = config.resources[variant.resource]!;
  if (variant.projectGrant) return `the project: ${variant.projectGrant}`;
  if (variant.grantOn)
    return `the resource the bound one names in \`${variant.grantOn.attribute}\``;
  if (resource.iamKind) return "the bound resource";
  if (resource.scopeByCondition) {
    return "the project, under an IAM condition matching only the bound resource";
  }
  return "the project (the service has no per-resource IAM policy)";
};

/** A binding for a call on the project (or a location) itself: no resource argument. */
const emitProjectContract = (service: string, binding: Binding) => {
  const first = binding.variants[0]!;
  const located = binding.variants.some((v) => v.scope === "location");
  const global = binding.variants.some((v) => v.scope === "project");
  const omitted = [first.param ?? first.projectField].filter((o): o is string => o !== undefined);
  const required = requiredMembers(first.api.moduleSource, first.types.request).filter(
    (m) => !omitted.includes(m),
  );
  const optional =
    required.length === 0 && (!located || global) && childFieldsOf(first).length === 0;
  const childLines = childFieldsOf(first).map(
    ([collection, field]) =>
      `  /** Id of the ${field} (\`${collection}/{${field}}\`). */\n  ${field}: string;`,
  );
  const fieldLines = [
    ...(located
      ? [
          `  /** Location to call in (\`projects/{project}/locations/{location}\`)${global ? "; the project itself when omitted" : ""}. */\n  location${global ? "?" : ""}: string;`,
        ]
      : []),
    ...childLines,
  ];
  const locationField = fieldLines.length ? ` {\n${fieldLines.join("\n")}\n}` : " {}";
  const responses = [...new Set(binding.variants.map((v) => `${v.api.ns}.${v.types.response}`))];
  const errors = [...new Set(binding.variants.map((v) => `${v.api.ns}.${v.types.error}`))];
  const variable = variableName(binding.name);
  const grants = [
    ...new Set(binding.variants.flatMap((v) => [v.role, ...v.also].map((r) => `\`${r}\``))),
  ].join(", ");
  const exampleFields = [
    ...(located && !global ? ['location: "us-central1"'] : []),
    ...childFieldsOf(first).map(([, field]) => `${field}: "..."`),
    ...required.map((f) => `${f}: ${f === "body" ? "{}" : `"..."`}`),
  ];
  return `${HEADER(service)}${apiImports(binding, true)}
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export interface ${binding.name}Request
  extends Omit<${first.api.ns}.${first.types.request}, ${omitted.map((o) => `"${o}"`).join(" | ") || "never"}>${locationField}

export type ${binding.name}Shape = () => Effect.Effect<
  (
    request${optional ? "?" : ""}: ${binding.name}Request,
  ) => Effect.Effect<${responses.join(" | ")}, ${errors.join(" | ")}, RuntimeContext>
>;

/**
 * ${binding.description.replace(/\*\//g, "*\\/") || `Runtime binding for \`${first.methodId}\`.`}
 *
 * A call on the stack's project${located ? " or one of its locations" : ""}, so it takes no resource.
 * Provide {@link ${binding.name}Http}. The host gets ${grants} on the project.
 *
 * ### Usage
 * **Example:** Call \`${first.methodId.split(".").slice(-2).join(".")}\`
 * \`\`\`typescript
 * const ${variable} = yield* GCP.${service}.${binding.name}();
 * const response = yield* ${variable}(${exampleFields.length ? `{ ${exampleFields.join(", ")} }` : ""});
 * \`\`\`
 *
 * @binding
 * @category ${service}
 */
export interface ${binding.name}
  extends Binding.Service<${binding.name}, "GCP.${service}.${binding.name}", ${binding.name}Shape> {}

export const ${binding.name} = Binding.Service<${binding.name}>("GCP.${service}.${binding.name}");
`;
};

const emitProjectHttp = (service: string, binding: Binding) => {
  const variants = binding.variants.map(
    (v) => `    {
      operation: ${v.api.ns}.${v.fn},
      ${v.param !== undefined ? `param: "${v.param}",` : v.projectField !== undefined ? `projectField: "${v.projectField}",` : "// A global call: nothing names the project."}${v.scope === "location" ? "\n      location: true," : ""}${v.children.length ? `\n      children: [${v.children.map(([c, f]) => `["${c}", "${f}"]`).join(", ")}],` : ""}
      role: "${v.role}",${v.also.length ? `\n      also: ${JSON.stringify(v.also)},` : ""}
    },`,
  );
  return `${HEADER(service)}${apiImports(binding, false)}
import * as Layer from "effect/Layer";
import { makeGcpProjectBinding } from "../HttpBinding.ts";
import { ${binding.name}, type ${binding.name}Shape } from "./${binding.name}.ts";

/**
 * HTTP implementation of {@link ${binding.name}}.
 *
 * @layer
 * @provides GCP.${service}.${binding.name}
 */
export const ${binding.name}Http = Layer.effect(
  ${binding.name},
  makeGcpProjectBinding<${binding.name}Shape>({
    tag: "GCP.${service}.${binding.name}",
    variants: [
${variants.join("\n")}
    ],
  }),
);
`;
};

const RESERVED = new Set([
  "process",
  "props",
  "resource",
  "events",
  "options",
  "function",
  "class",
  "delete",
  "default",
  "new",
  "import",
  "export",
  "package",
  "interface",
  "enum",
  "return",
  "switch",
  "case",
  "this",
  "var",
  "let",
  "const",
  "in",
  "do",
  "for",
  "while",
]);

/** A camelCase variable for a type or binding name, avoiding reserved words. */
const variableName = (name: string) => {
  const variable = name[0]!.toLowerCase() + name.slice(1);
  return RESERVED.has(variable) ? `${variable}Resource` : variable;
};

/** Import a resource's type under its key. */
const importName = (resource: ResourceConfig, key: string) =>
  resource.typeName ? `${resource.typeName} as ${key}` : key;

const emitContract = (service: string, config: ServiceConfig, binding: Binding) => {
  if (binding.variants[0]!.scope !== undefined) return emitProjectContract(service, binding);
  const first = binding.variants[0]!;
  const moduleSource = first.api.moduleSource;
  const resourceTypes = [...new Set(binding.variants.map((v) => v.resource))];
  // A resource named `Binding` (Agent Registry) shadows alchemy's module.
  const bindingNs = resourceTypes.includes("Binding") ? "AlchemyBinding" : "Binding";
  const childFields = [
    ...childFieldsOf(first).map(([, field]) => field),
    ...(first.suffix ? [first.suffix[1]] : []),
  ];
  const omitted = [
    ...(first.param !== undefined ? [first.param] : []),
    ...Object.keys(first.params ?? {}),
  ];
  const required = requiredMembers(moduleSource, first.types.request).filter(
    (m) => !omitted.includes(m),
  );
  const optional = required.length === 0 && childFields.length === 0;
  const fieldDocs = [
    ...childFieldsOf(first).map(([collection, field]) => [
      field,
      `Id of the ${field} under the bound resource (\`${collection}/{${field}}\`).`,
    ]),
    ...(first.suffix
      ? [[first.suffix[1], `Appended to the bound resource's name after \`${first.suffix[0]}\`.`]]
      : []),
  ];
  const childType = fieldDocs.length
    ? ` {\n${fieldDocs.map(([f, doc]) => `  /** ${doc} */\n  ${f}: string;`).join("\n")}\n}`
    : " {}";
  const responses = [...new Set(binding.variants.map((v) => `${v.api.ns}.${v.types.response}`))];
  const errors = [...new Set(binding.variants.map((v) => `${v.api.ns}.${v.types.error}`))];
  const resourceDocs = resourceTypes.map((r) => `{@link ${r}}`).join(" or ");
  const variable = variableName(binding.name);
  const grants = [
    ...new Set(binding.variants.flatMap((v) => [v.role, ...v.also].map((r) => `\`${r}\``))),
  ].join(", ");
  return `${HEADER(service)}${apiImports(binding, true)}
import * as ${bindingNs} from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
${resourceTypes.map((r) => `import type { ${importName(config.resources[r]!, r)} } from "./${config.resources[r]!.file ?? r}.ts";`).join("\n")}

export interface ${binding.name}Request
  extends Omit<${first.api.ns}.${first.types.request}, ${omitted.map((o) => `"${o}"`).join(" | ") || "never"}>${childType}

export type ${binding.name}Shape = (
  resource: ${resourceTypes.join(" | ")},
) => Effect.Effect<
  (
    request${optional ? "?" : ""}: ${binding.name}Request,
  ) => Effect.Effect<${responses.join(" | ")}, ${errors.join(" | ")}, RuntimeContext>
>;

/**
 * ${binding.description.replace(/\*\//g, "*\\/") || `Runtime binding for \`${first.methodId}\`.`}
 *
 * Bind it to a ${resourceDocs} and provide {@link ${binding.name}Http}. The
 * host gets ${grants} on ${grantScope(config, first)}.
 *
 * ### Usage
 * **Example:** Call \`${first.methodId.split(".").slice(-2).join(".")}\`
 * \`\`\`typescript
 * const ${variable} = yield* GCP.${service}.${binding.name}(${variableName(resourceTypes[0]!)});
 * const response = yield* ${variable}(${optional ? "" : `{ ${[...childFields.map((f) => `${f}: "..."`), ...required.map((f) => `${f}: ${f === "body" ? "{}" : `"..."`}`)].join(", ")} }`});
 * \`\`\`
 *
 * @binding
 * @category ${service}
 */
export interface ${binding.name}
  extends ${bindingNs}.Service<${binding.name}, "GCP.${service}.${binding.name}", ${binding.name}Shape> {}

export const ${binding.name} = ${bindingNs}.Service<${binding.name}>("GCP.${service}.${binding.name}");
`;
};

const emitHttp = (service: string, config: ServiceConfig, binding: Binding) => {
  if (binding.variants[0]!.scope !== undefined) return emitProjectHttp(service, binding);
  const variants = binding.variants.map((v) => {
    const resource = config.resources[v.resource]!;
    const type = resource.type ?? `GCP.${service}.${v.resource}`;
    const iamKind = v.projectGrant ? undefined : v.grantOn ? v.grantOn.iamKind : resource.iamKind;
    const also = v.also.length ? `, also: ${JSON.stringify(v.also)}` : "";
    const iam = iamKind
      ? `{ role: "${v.role}", on: "${iamKind}"${also} }`
      : resource.scopeByCondition && !v.projectGrant
        ? `{ role: "${v.role}", scopeByCondition: true${also} }`
        : `{ role: "${v.role}"${also} }`;
    const children =
      (v.children.length
        ? `\n      children: [${v.children.map(([c, f]) => `["${c}", "${f}"]`).join(", ")}],`
        : "") +
      (v.suffix ? `\n      suffix: ["${v.suffix[0]}", "${v.suffix[1]}"],` : "") +
      (v.append ? `\n      append: "${v.append}",` : "") +
      (v.grantOn
        ? `\n      grantOn: "${v.grantOn.attribute}",`
        : resource.nameAttribute
          ? `\n      grantOn: "${resource.nameAttribute}",`
          : "");
    return `    {
      resource: "${type}",
      operation: ${v.api.ns}.${v.fn},
      ${v.param !== undefined ? `param: "${v.param}",${v.params ? `\n      params: ${JSON.stringify(v.params)},` : ""}` : `params: ${JSON.stringify(v.params)},`}${children}
      iam: ${iam},
    },`;
  });
  return `${HEADER(service)}${apiImports(binding, false)}
import * as Layer from "effect/Layer";
import { makeGcpBinding } from "../HttpBinding.ts";
import { ${binding.name}, type ${binding.name}Shape } from "./${binding.name}.ts";

/**
 * HTTP implementation of {@link ${binding.name}}.
 *
 * @layer
 * @provides GCP.${service}.${binding.name}
 */
export const ${binding.name}Http = Layer.effect(
  ${binding.name},
  makeGcpBinding<${binding.name}Shape>({
    tag: "GCP.${service}.${binding.name}",
    variants: [
${variants.join("\n")}
    ],
  }),
);
`;
};

/**
 * `consume<Resource>AuditLogs`: the Cloud Audit Logs entries for one
 * resource and its children, through `GCP.Logging.AuditLogEventSource`.
 */
/**
 * The audit-log resource name expression: `name`, or a template over the
 * resource's attributes (`auditName`, or `pattern` filled from
 * `attributes`): `projects/{project}/zones/{zone}/instances/{instanceName}`.
 */
const auditNameOf = (resource: ResourceConfig) => {
  let i = 0;
  const template =
    resource.auditName ??
    (resource.attributes
      ? resource.pattern.replace(/\*/g, () => `{${resource.attributes![i++]}}`)
      : undefined);
  return template
    ? `Output.interpolate\`${template.replace(/\{(\w+)\}/g, "${resource.$1}")}\``
    : "resource.name";
};

const emitAuditLogs = (
  service: string,
  key: string,
  resource: ResourceConfig,
  serviceNames: readonly string[],
) => {
  const variable = variableName(key);
  const type = resource.type ?? `GCP.${service}.${key}`;
  return `${HEADER(service)}import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import {
  AuditLogEventSource,
  resourceAuditLogFilter,
  type AuditLogEventSourceProps,
  type AuditLogEventsHandler,
} from "../Logging/AuditLogEventSource.ts";
import type { ${importName(resource, key)} } from "./${resource.file ?? key}.ts";

export interface ${key}AuditLogsProps extends Omit<AuditLogEventSourceProps, "filter"> {
  /**
   * RPC method names to deliver, without their service prefix, e.g.
   * \`["Delete${key}"]\` for \`google.….Delete${key}\`. Every method when omitted.
   */
  methods?: string[];
}

/**
 * Subscribe an Effect handler to the Cloud Audit Logs entries for a
 * {@link ${key}} (\`${type}\`) and its children: every call to
 * ${serviceNames.map((name) => `\`${name}\``).join(" or ")} that names it.
 *
 * Admin Activity entries (configuration and metadata changes) are always
 * written; Data Access entries (reads and data calls) only where the
 * project enables Data Access audit logs for the service. Provide
 * \`GCP.Logging.AuditLogEventSourceLive\` and a
 * \`GCP.PubSub.TopicEventSource\` implementation.
 *
 * ### Usage
 * **Example:** Log every change to a ${key}
 * \`\`\`typescript
 * yield* GCP.${service}.consume${key}AuditLogs(${variable}, (events) =>
 *   events.pipe(Stream.runForEach((event) => Effect.log(event.methodName))),
 * );
 * \`\`\`
 */
export function consume${key}AuditLogs<Req = never, ResourceReq = never>(
  ${variable}: ${key} | Effect.Effect<${key}, never, ResourceReq>,
  process: AuditLogEventsHandler<Req>,
): Effect.Effect<void, never, AuditLogEventSource | ResourceReq>;
export function consume${key}AuditLogs<Req = never, ResourceReq = never>(
  ${variable}: ${key} | Effect.Effect<${key}, never, ResourceReq>,
  props: ${key}AuditLogsProps,
  process: AuditLogEventsHandler<Req>,
): Effect.Effect<void, never, AuditLogEventSource | ResourceReq>;
export function consume${key}AuditLogs<Req = never, ResourceReq = never>(
  ${variable}: ${key} | Effect.Effect<${key}, never, ResourceReq>,
  propsOrProcess: ${key}AuditLogsProps | AuditLogEventsHandler<Req>,
  maybeProcess?: AuditLogEventsHandler<Req>,
): Effect.Effect<void, never, AuditLogEventSource | ResourceReq> {
  const [{ methods, ...props }, process] =
    typeof propsOrProcess === "function"
      ? [{} as ${key}AuditLogsProps, propsOrProcess]
      : [propsOrProcess, maybeProcess!];
  const resolved = Effect.isEffect(${variable}) ? ${variable} : Effect.succeed(${variable});
  return resolved.pipe(
    Effect.flatMap((resource) =>
      AuditLogEventSource.use((source) =>
        source(
          resource.LogicalId,
          {
            ...props,
            filter: Output.map(${auditNameOf(resource)}, (resourceName) =>
              resourceAuditLogFilter({
                serviceNames: ${JSON.stringify(serviceNames)},
                resourceName,
                methods,
              }),
            ),
          },
          process,
        ),
      ),
    ),
  );
}
`;
};

// ============ Program ============

const generateService = Effect.fn(function* (root: string, service: string, report: boolean) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bindingsDir = path.join(root, "packages/gcp/bindings");
  const serviceDir = path.join(root, "packages/gcp/src", service);
  const distilled = path.join(root, "submodules/distilled/packages/gcp");
  const config = JSON.parse(
    yield* fs.readFileString(path.join(bindingsDir, `${service}.json`)),
  ) as ServiceConfig;
  const roles = JSON.parse(yield* fs.readFileString(path.join(bindingsDir, "roles.json")));
  const apiConfigs = [
    ...(config.discovery && config.module ? [config as ApiConfig] : []),
    ...(config.apis ?? []),
  ];
  const apis: Api[] = [];
  for (const api of apiConfigs) {
    const doc = JSON.parse(
      yield* fs.readFileString(
        path.join(distilled, "specs/spec-mirror-gcp/specs", `${api.discovery}.json`),
      ),
    );
    const moduleSource = yield* fs.readFileString(
      path.join(
        distilled,
        "src",
        api.unstable ? "unstable-services" : "services",
        `${api.module}.ts`,
      ),
    );
    apis.push({
      ...api,
      ns: api.module.replace(/_v.*$/, ""),
      importPath: `@distilled.cloud/gcp/${api.unstable ? "unstable/" : ""}${api.module}`,
      doc,
      moduleSource,
    });
  }

  // Operations a hand-written binding already calls, per distilled module,
  // whatever alias the file imports it under.
  const files = yield* fs.readDirectory(serviceDir);
  const generated = new Set<string>();
  const covered = new Map<string, Set<string>>(apis.map((a) => [a.module, new Set()]));
  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const source = yield* fs.readFileString(path.join(serviceDir, file));
    if (source.startsWith("// @generated by scripts/generate-gcp-bindings.ts")) {
      generated.add(file);
      continue;
    }
    // Only binding implementations count; resource providers call lifecycle ops.
    if (!file.endsWith("Http.ts")) continue;
    for (const imp of source.matchAll(
      /import \* as (\w+) from "@distilled\.cloud\/gcp\/(?:unstable\/)?(\w+)"/g,
    )) {
      const ops = covered.get(imp[2]!);
      if (ops === undefined) continue;
      for (const m of source.matchAll(new RegExp(`\\b${imp[1]}\\.(\\w+)\\b`, "g"))) ops.add(m[1]!);
    }
  }

  const bindingMap = new Map<string, Binding>();
  const results = apis.flatMap((api) =>
    classify({ config, api, covered: covered.get(api.module)!, roles, bindings: bindingMap }),
  );
  const bindings = [...bindingMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  yield* Console.log(
    `${service}: ${Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")} → ${bindings.length} bindings`,
  );
  if (report) {
    for (const b of bindings) {
      yield* Console.log(
        `  binding          ${b.name}  ${b.variants.map((v) => `${v.resource}:${v.fn}→${v.role}`).join(" ")}`,
      );
    }
    for (const r of results.filter((r) => r.kind !== "binding" && r.kind !== "internal")) {
      yield* Console.log(`  ${r.kind.padEnd(16)} ${r.id}${r.reason ? `  (${r.reason})` : ""}`);
    }
    return;
  }

  const handWritten = new Set(files.filter((f) => !generated.has(f)));
  const written = new Set<string>();
  for (const binding of bindings) {
    for (const file of [`${binding.name}.ts`, `${binding.name}Http.ts`]) {
      if (handWritten.has(file)) {
        return yield* Effect.die(
          new Error(
            `${service}/${file} is hand-written; set a "names" override for ${binding.name}`,
          ),
        );
      }
    }
    yield* fs.writeFileString(
      path.join(serviceDir, `${binding.name}.ts`),
      emitContract(service, config, binding),
    );
    yield* fs.writeFileString(
      path.join(serviceDir, `${binding.name}Http.ts`),
      emitHttp(service, config, binding),
    );
    written.add(`${binding.name}.ts`).add(`${binding.name}Http.ts`);
  }
  const serviceNames = config.auditServices ?? [
    ...new Set(apis.map((api) => new URL(api.doc.rootUrl).host.replace(/^[a-z0-9-]+\.mtls\./, ""))),
  ];
  const auditLogs: string[] = [];
  // Resource modules declaring a `name: string` attribute: an audit filter
  // needs the resource's full name.
  const named = new Set<string>();
  const sources = yield* Effect.forEach(
    files.filter((f) => f.endsWith(".ts")),
    (f) => fs.readFileString(path.join(serviceDir, f)).pipe(Effect.orElseSucceed(() => "")),
  );
  for (const [key, resource] of Object.entries(config.resources)) {
    const type = resource.type ?? `GCP.${service}.${key}`;
    const source = sources.find((text) => new RegExp(`Resource<\\s*"${type}"`).test(text));
    if (source !== undefined && /\n\s+name: string;/.test(source)) named.add(key);
  }
  // A child with no IAM of its own is covered by its parent's audit logs
  // (the filter matches the parent and everything below it).
  for (const [key, resource] of Object.entries(config.resources).filter(
    ([key, resource]) =>
      !resource.lifecycleOnly &&
      resource.noAuditLogs === undefined &&
      // The audit filter needs the resource's full name: a `name: string`
      // attribute, or a template over its attributes.
      (resource.auditName !== undefined || resource.attributes !== undefined || named.has(key)),
  )) {
    const file = `${key}AuditLogs.ts`;
    if (handWritten.has(file)) {
      return yield* Effect.die(new Error(`${service}/${file} is hand-written`));
    }
    yield* fs.writeFileString(
      path.join(serviceDir, file),
      emitAuditLogs(service, key, resource, serviceNames),
    );
    written.add(file);
    auditLogs.push(file);
  }
  // Drop generated files whose method no longer generates.
  for (const file of generated) {
    if (!written.has(file) && file !== "generated.ts") {
      yield* fs.remove(path.join(serviceDir, file));
    }
  }
  yield* fs.writeFileString(
    path.join(serviceDir, "generated.ts"),
    `${HEADER(service)}${
      [
        ...bindings.flatMap((b) => [`./${b.name}.ts`, `./${b.name}Http.ts`]),
        ...auditLogs.map((file) => `./${file}`),
      ]
        .map((file) => `export * from "${file}";`)
        .join("\n") || "export {};"
    }\n`,
  );
  const indexPath = path.join(serviceDir, "index.ts");
  const index = yield* fs.readFileString(indexPath);
  if (!index.includes(`"./generated.ts"`)) {
    yield* fs.writeFileString(indexPath, `${index.trimEnd()}\nexport * from "./generated.ts";\n`);
  }
  const probeFiles: string[] = [];
  if (config.probes) {
    const probes = probesOf(config, bindings);
    const testDir = path.join(root, "packages/integration-tests/test/GCP", service);
    yield* fs.makeDirectory(path.join(testDir, "fixtures"), { recursive: true });
    const hostFile = path.join(testDir, "fixtures/generated-host.ts");
    const testFile = path.join(testDir, "Generated.test.ts");
    yield* fs.writeFileString(hostFile, emitProbeHost(service, config, probes));
    yield* fs.writeFileString(
      testFile,
      emitProbeTest(
        service,
        config,
        probes,
        results.filter(
          (r) => r.kind === "skip" || r.kind === "project" || r.kind === "needs-permission",
        ),
      ),
    );
    probeFiles.push(hostFile, testFile);
  }
  // Format what was written, so regenerating is a no-op diff.
  const spawner = yield* ChildProcessSpawner;
  yield* spawner.string(
    ChildProcess.make(
      "pnpm",
      [
        "exec",
        "oxfmt",
        ...[...written, "generated.ts", "index.ts"].map((f) => path.join(serviceDir, f)),
        ...probeFiles,
      ],
      { cwd: root, stdin: "ignore", stderr: "ignore" },
    ),
  );
});

// ============ Probes ============

const PLACEHOLDER = "alchemy-missing";

/** A placeholder for a required request field: valid where the name says what it is. */
const placeholder = (field: string, type: string, location = "us-central1") => {
  if (/^"/.test(type)) return type.split("|")[0]!.trim();
  if (type === "string") {
    if (field === "zone") return `"us-central1-a"`;
    if (field === "region") return `"us-central1"`;
    if (field === "location") return `"${location}"`;
    return `"${PLACEHOLDER}"`;
  }
  if (type === "number") return "1";
  if (type === "boolean") return "false";
  if (type.endsWith("[]") || type.startsWith("Array<") || type.endsWith("List")) return "[]";
  return "{}";
};

/** Fields a placeholder fills with a real value, so a read can still succeed. */
const KNOWN_FIELDS = new Set(["zone", "region", "location"]);

interface Probe {
  name: string;
  binding: Binding;
  variant: Variant;
  /** The resource key it binds, or undefined for a project-scoped binding. */
  key: string | undefined;
  args: string;
  /** A plain read of the bound resource (or project): it must succeed. */
  expectSuccess: boolean;
  skip: string | undefined;
  /** Not run yet: the fixture doesn't deploy the resource it binds (a `test.todo`). */
  todo: string | undefined;
}

const probesOf = (config: ServiceConfig, bindings: Binding[]): Probe[] => {
  const probes = config.probes!;
  return bindings.flatMap((binding) => {
    const project = binding.variants[0]!.scope !== undefined;
    if (!project && probes.coveredBy !== undefined) return [];
    const variants = project
      ? [binding.variants[0]!]
      : [...new Map(binding.variants.map((v) => [v.resource, v])).values()];
    return variants.map((variant): Probe => {
      const key = project ? undefined : variant.resource;
      const omitted = project
        ? [variant.param ?? variant.projectField].filter((o): o is string => o !== undefined)
        : [
            ...(variant.param !== undefined ? [variant.param] : []),
            ...Object.keys(variant.params ?? {}),
          ];
      const fields: [string, string][] = [
        ...childFieldsOf(variant).map(([, field]): [string, string] => [field, "string"]),
        ...(variant.suffix ? [[variant.suffix[1], "string"] as [string, string]] : []),
        ...requiredFieldTypes(variant.api.moduleSource, variant.types.request).filter(
          ([field]) => !omitted.includes(field),
        ),
        ...(project &&
        !binding.variants.some((v) => v.scope === "project") &&
        binding.variants.some((v) => v.scope === "location")
          ? [["location", "string"] as [string, string]]
          : []),
      ];
      // A call that creates something gets a body with an unknown field:
      // the API rejects it (after the IAM check), so a probe never creates
      // a resource the stack doesn't own.
      const creates = /^(create|insert|bulkInsert|clone|duplicate|copy|import|restore|add)/.test(
        binding.verb,
      );
      const hasBody = interfaceBody(variant.api.moduleSource, variant.types.request).includes(
        "\n  body",
      );
      const entries = fields
        .filter(([field]) => !(creates && hasBody && field === "body"))
        .map(
          ([field, type]) =>
            `${JSON.stringify(field)}: ${placeholder(field, type, probes.locations?.[binding.name] ?? probes.location)}`,
        );
      if (creates && hasBody) entries.push(`"body": { alchemyProbe: "${PLACEHOLDER}" }`);
      const args = probes.args?.[binding.name] ?? `{ ${entries.join(", ")} }`;
      const name = variants.length > 1 ? `${binding.name}@${key}` : binding.name;
      return {
        name,
        binding,
        variant,
        key,
        args,
        expectSuccess:
          /^(get|list|aggregatedList)$/.test(binding.verb) &&
          probes.args?.[binding.name] === undefined &&
          fields.every(([field]) => KNOWN_FIELDS.has(field)),
        skip:
          probes.skip?.[binding.name] ??
          probes.untestable?.["*"] ??
          (key === undefined ? probes.untestable?.["project"] : undefined) ??
          (key !== undefined && probes.untestable?.[key] !== undefined
            ? `${key}: ${probes.untestable[key]}`
            : undefined),
        todo:
          key !== undefined && probes.resources[key] === undefined
            ? `${key}: the probe fixture doesn't deploy one yet`
            : undefined,
      };
    });
  });
};

const chunk = <A>(items: A[], size: number): A[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

const PROBE_HEADER = (service: string) =>
  `// @generated by scripts/generate-gcp-bindings.ts from packages/gcp/bindings/${service}.json. Do not edit.\n`;

const emitProbeHost = (service: string, config: ServiceConfig, probes: Probe[]) => {
  const live = probes.filter((p) => p.skip === undefined && p.todo === undefined);
  const layers = [...new Set(live.map((p) => `GCP.${service}.${p.binding.name}Http`))];
  const exports = [
    ...new Set(live.flatMap((p) => (p.key ? [config.probes!.resources[p.key]!] : []))),
  ];
  return `${PROBE_HEADER(service)}import * as GCP from "@alchemy.run/gcp";
import * as Retry from "@distilled.cloud/gcp/Retry";
import * as Effect from "effect/Effect";
${layers.length ? 'import * as Layer from "effect/Layer";\n' : ""}import { ${live.some((p) => p.args.includes("yield* hostProject")) ? "hostProject, " : ""}probeOutcome, serveProbes } from "../../bindingHost.ts";
${exports.length ? `import { ${exports.sort().join(", ")} } from "./generated-resources.ts";` : ""}

/**
 * Cloud Run service calling every generated ${service} binding as its own
 * runtime service account. Deployed from {@link ../Generated.test.ts}.
 * Each call reports its first answer (\`Retry.none\`): a probe checks the
 * call is authorized, not that a transient error clears.
 */
export default class ${service}GeneratedHost extends GCP.Function<${service}GeneratedHost>()(
  "${service}GeneratedHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
${live.map((p, i) => `    const p${i} = yield* GCP.${service}.${p.binding.name}(${p.key ? config.probes!.resources[p.key] : ""});`).join("\n")}
    return {
      fetch: serveProbes({
${live.map((p, i) => `        ${JSON.stringify(p.name)}: probeOutcome(Retry.none(p${i}(${p.args} as never))),`).join("\n")}
      }),
    };
  })${
    layers.length
      ? `.pipe(
    Effect.provide(
      Layer.mergeAll(
${chunk(layers, 40)
  .map(
    (group) =>
      `        Layer.mergeAll(\n${group.map((l) => `          ${l},`).join("\n")}\n        ),`,
  )
  .join("\n")}
      ),
    ),
  )`
      : ""
  },
) {}
`;
};

const emitProbeTest = (
  service: string,
  config: ServiceConfig,
  probes: Probe[],
  unbound: Classified[],
) => {
  const enables = (config.probes!.enable ?? [])
    .map(
      (api, i) =>
        `          yield* GCP.ServiceUsage.ProjectService("ProbeApi${i}", { service: "${api}" });\n`,
    )
    .join("");
  const groups = new Map<string, Probe[]>();
  for (const probe of probes) {
    const group = probe.key ?? "project";
    groups.set(group, [...(groups.get(group) ?? []), probe]);
  }
  const tags = `["provider:gcp", "provider:gcp:${service.toLowerCase()}", "live"]`;
  const networks = config.probes!.networks ?? 0;
  // Milliseconds with digit grouping, as oxfmt leaves it (`1_800_000`).
  const timeout = ((config.probes!.deployMinutes ?? 30) * 60_000)
    .toString()
    .replace(/\B(?=(\d{3})+$)/g, "_");
  return `${PROBE_HEADER(service)}import * as GCP from "@alchemy.run/gcp";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { callProbe, outcomeTag } from "../bindingHost.ts";
${networks ? `import { releaseNetworkSlots, takeNetworkSlots } from "../networkQuota.ts";\n` : ""}import ${service}GeneratedHost from "./fixtures/generated-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "${service}Generated");

let baseUrl: string;

${Object.entries(config.probes!.allowedOutcomes ?? {})
  .map(([tag, reason]) => `// A plain read may answer ${tag}: ${reason}.`)
  .join("\n")}
const ALLOWED: string[] = ${JSON.stringify(Object.keys(config.probes!.allowedOutcomes ?? {}))};
${Object.entries(config.probes!.ambiguousTags ?? {})
  .map(([tag, reason]) => `// ${tag} is retried while a grant propagates: ${reason}.`)
  .join("\n")}
const AMBIGUOUS: string[] = ${JSON.stringify(Object.keys(config.probes!.ambiguousTags ?? {}))};

/**
 * Call one binding on the deployed host. \`callProbe\` retries while the
 * binding's IAM grant propagates, so a result means the call was authorized
 * and reached the API; a plain read of the bound resource must succeed.
 */
const probe = (name: string, expectSuccess: boolean) =>
  Effect.gen(function* () {
    const call = callProbe<string>(baseUrl, name).pipe(
      Effect.map((result) => (result.ok ? result.value : result.error._tag)),
    );
    const outcome =
      AMBIGUOUS.length === 0
        ? yield* call
        : yield* call.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (value) => !AMBIGUOUS.includes(outcomeTag(value)),
              times: 30,
            }),
          );
    if (expectSuccess)
      expect(ALLOWED.includes(outcomeTag(outcome)) ? "succeeded" : outcome).toEqual("succeeded");
    else expect(typeof outcome).toEqual("string");
  });

// Deploys one of every bindable resource: slow, so \`--fast\` skips it.
${config.probes!.coveredBy ? `// Resource-bound bindings run live in ${config.probes!.coveredBy}.\n` : ""}describe.skipIf(!!process.env.FAST)(
  "${service} generated bindings",
  { tags: ${tags}, concurrent: true },
  () => {
  beforeAll(
    Effect.gen(function* () {
${networks ? `      yield* takeNetworkSlots(${networks});\n` : ""}      yield* sharedStack.destroy();
${
  enables
    ? `      // The APIs first: the probe resources need them enabled to deploy.
      yield* sharedStack.deploy(
        Effect.gen(function* () {
${enables}        }),
      );
`
    : ""
}      const out = yield* sharedStack.deploy(
        Effect.gen(function* () {
${enables}          const host = yield* ${service}GeneratedHost;
          return { uri: host.uri };
        }),
      );
      baseUrl = out.uri!;
    }),
    { timeout: ${timeout} },
  );

  afterAll(${networks ? `sharedStack.destroy().pipe(Effect.ensuring(releaseNetworkSlots(${networks})))` : "sharedStack.destroy()"}, { timeout: ${timeout} });
${[...groups.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(
    ([group, items]) => `
  describe(${JSON.stringify(group)}, { concurrent: true }, () => {
${items
  .map((p) =>
    p.skip !== undefined
      ? `    test.provider.skip(${JSON.stringify(`${p.name} (${p.variant.methodId}): ${p.skip}`)}, () => Effect.void);`
      : p.todo !== undefined
        ? `    test.provider.todo(${JSON.stringify(`${p.name} (${p.variant.methodId}): ${p.todo}`)}, () => Effect.void);`
        : `    test.provider(${JSON.stringify(`${p.name} (${p.variant.methodId})`)}, () => probe(${JSON.stringify(p.name)}, ${p.expectSuccess}), {
      tags: ${tags},
      timeout: 600_000,
    });`,
  )
  .join("\n")}
  });`,
  )
  .join("\n")}${
    unbound.length
      ? `

  // Discovery methods with no binding, and why.
  describe("not generated", () => {
${unbound
  .map(
    (r) =>
      `    test.provider.skip(${JSON.stringify(`${r.id}: ${r.kind === "needs-permission" ? `no predefined role grants ${r.reason ?? "its permission"}` : (r.reason ?? r.kind)}`)}, () => Effect.void);`,
  )
  .join("\n")}
  });`
      : ""
  }
});
`;
};

// ============ Roles ============

interface Role {
  name: string;
  stage?: string;
  deleted?: boolean;
  includedPermissions?: string[];
}

const BASIC_ROLES = new Set(["roles/owner", "roles/editor", "roles/viewer", "roles/browser"]);
const READ_ONLY_ROLE = /(viewer|reader)$/i;

/**
 * The role a binding grants for `permission`: the predefined role holding it
 * with the fewest permissions, preferring the permission's own service
 * (`roles/pubsub.*` for `pubsub.topics.get`). A `get`/`list` permission
 * prefers a read-only role (named `*viewer`/`*reader`) of its service, so a
 * read never grants one that can also write (`spanner.backupWriter` is
 * smaller than `spanner.viewer`). Basic, service-agent and deprecated roles
 * never qualify.
 */
const pickRole = (permission: string, candidates: Role[]) => {
  const service = permission.split(".")[0]!;
  const own = (role: Role) => role.name.startsWith(`roles/${service}.`);
  const smallest = (roles: Role[]) =>
    [...roles].sort(
      (a, b) =>
        Number(!own(a)) - Number(!own(b)) ||
        a.includedPermissions!.length - b.includedPermissions!.length ||
        a.name.localeCompare(b.name),
    )[0];
  const readOnly = /\.(get|list)$/.test(permission)
    ? candidates.filter((role) => own(role) && READ_ONLY_ROLE.test(role.name))
    : [];
  return smallest(readOnly.length > 0 ? readOnly : candidates)?.name;
};

/** Rebuild `roles.json` from every predefined role (IAM `roles.list`, full view). */
const refreshRoles = Effect.fn(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner;
  const token = (yield* spawner.string(
    ChildProcess.make("gcloud", ["auth", "print-access-token"], { stdin: "ignore" }),
  )).trim();
  const client = yield* HttpClient.HttpClient;
  const roles: Role[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL("https://iam.googleapis.com/v1/roles");
    url.searchParams.set("view", "FULL");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const response = yield* client.get(url.toString(), {
      headers: { authorization: `Bearer ${token}` },
    });
    const page = (yield* response.json) as { roles?: Role[]; nextPageToken?: string };
    roles.push(...(page.roles ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  const byPermission = new Map<string, Role[]>();
  for (const role of roles) {
    if (
      BASIC_ROLES.has(role.name) ||
      role.deleted ||
      role.stage === "DEPRECATED" ||
      /serviceagent/i.test(role.name)
    ) {
      continue;
    }
    for (const permission of role.includedPermissions ?? []) {
      byPermission.set(permission, [...(byPermission.get(permission) ?? []), role]);
    }
  }
  const map = Object.fromEntries(
    [...byPermission.keys()]
      .sort()
      .map((permission) => [permission, pickRole(permission, byPermission.get(permission)!)!]),
  );
  yield* fs.writeFileString(
    path.join(root, "packages/gcp/bindings/roles.json"),
    `${JSON.stringify(map, null, 2)}\n`,
  );
  yield* Console.log(
    `roles.json: ${Object.keys(map).length} permissions from ${roles.length} roles`,
  );
});

const services = Argument.String("service").pipe(Argument.variadic());

const command = Command.make(
  "generate-gcp-bindings",
  {
    services,
    report: Flag.Boolean("report").pipe(Flag.withDefault(false)),
    refreshRoles: Flag.Boolean("refresh-roles").pipe(Flag.withDefault(false)),
    check: Flag.Boolean("check").pipe(Flag.withDefault(false)),
  },
  Effect.fn(function* ({ services, report, refreshRoles: refresh, check }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve(import.meta.dirname, "..");
    if (refresh) {
      yield* refreshRoles(root);
      if (services.length === 0) return;
    }
    const all = (yield* fs.readDirectory(path.join(root, "packages/gcp/bindings")))
      .filter((f) => f.endsWith(".json") && f !== "roles.json")
      .map((f) => f.slice(0, -5))
      .sort();
    for (const service of services.length > 0 ? services : all) {
      yield* generateService(root, service, report);
    }
    if (check) {
      // Regenerated in place: anything git now sees as changed was stale.
      const spawner = yield* ChildProcessSpawner;
      const status = yield* spawner.string(
        ChildProcess.make(
          "git",
          ["status", "--porcelain", "--", "packages/gcp", "packages/integration-tests/test/GCP"],
          {
            cwd: root,
            stdin: "ignore",
          },
        ),
      );
      if (status.trim().length > 0) {
        yield* Console.error(
          `Generated GCP bindings are out of date; run \`node scripts/generate-gcp-bindings.ts\` and commit:\n${status}`,
        );
        return yield* Effect.die(new Error("stale generated GCP bindings"));
      }
      yield* Console.log("Generated GCP bindings are up to date.");
    }
  }),
);

Command.run(command, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain,
);
