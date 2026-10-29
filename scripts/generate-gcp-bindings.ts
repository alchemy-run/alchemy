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
   * Permission → role, where `roles.json`'s smallest role is a poor fit:
   * `artifactregistry.repositories.get` is smallest in a migration role
   * that also reads Cloud Storage.
   */
  roles?: Record<string, string>;
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
  word.endsWith("ies")
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
  const parts = path.replace(/:[A-Za-z]+$/, "").split("/");
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
  const { doc, moduleSource } = api;
  const permissionService = api.permissionService ?? doc.name;
  const resources = Object.entries(config.resources).map(([key, value]) => ({
    key,
    ...value,
    segments: value.pattern.split("/"),
  }));
  const results: Classified[] = [];
  const ownCollections = new Set(resources.map((r) => r.segments.at(-2)));
  const methods = collectMethods(doc, [], []);
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
      .filter((t): t is { param: string; segments: string[] } => t.segments !== undefined)
      // A full name has a collection in it; `^[^/]+$` is one segment of a flat path.
      .filter((t) => t.segments.length > 1);
    // Otherwise the method's own path, for APIs with one parameter per segment.
    const flat = flatTarget(method.path);
    const target: { param: string | undefined; segments: string[]; params?: string[] } | undefined =
      targets.sort((a, b) => b.segments.length - a.segments.length)[0] ?? flat;
    if (target === undefined) {
      results.push({ id, kind: "project", reason: "no resource-name path parameter" });
      continue;
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
          (config.append?.[id] !== undefined ||
            (target.segments.length - r.segments.length) % 2 === 0),
      )
      .sort((a, b) => b.segments.length - a.segments.length)[0];
    const projectCall = config.projectCalls?.includes(id) ?? false;
    const created =
      !projectCall &&
      (verb === "create" || verb === "insert") &&
      resources.some((r) => r.segments.at(-2) === cols.at(-1));
    // Nothing to bind to: a call on the project (or one of its locations)
    // itself becomes a project-scoped binding.
    const scope =
      (matched !== undefined && !projectCall) || created
        ? undefined
        : target.segments.join("/") === "projects/*"
          ? ("project" as const)
          : target.param !== undefined && target.segments.join("/") === "projects/*/locations/*"
            ? ("location" as const)
            : undefined;
    const resource =
      (projectCall ? undefined : matched) ??
      (scope !== undefined && !config.noProjectBindings
        ? {
            key: `@${scope}`,
            pattern: target.segments.join("/"),
            segments: target.segments,
          }
        : undefined);
    if (resource === undefined) {
      results.push(
        created
          ? { id, kind: "lifecycle" }
          : { id, kind: "project", reason: target.segments.join("/") },
      );
      continue;
    }
    const extra = config.append?.[id] ? [] : target.segments.slice(resource.segments.length);
    // Name-style targets assemble child segments from request fields; a flat
    // target's further path parameters are already request fields.
    const children: [string, string][] = [];
    for (let i = 0; target.param !== undefined && i < extra.length; i += 2) {
      children.push([extra[i]!, singular(extra[i]!)]);
    }
    // Flat target: the method parameter at each of the resource's wildcards,
    // filled from the matching attribute.
    const params: Record<string, string> | undefined =
      target.param === undefined && resource.attributes
        ? Object.fromEntries(
            resource.attributes.map((attribute, i) => [target.params![i]!, attribute]),
          )
        : undefined;
    const ownCollection = resource.segments.at(-2);
    if (
      (LIFECYCLE_VERBS.has(verb) && extra.length === 0 && cols.at(-1) === ownCollection) ||
      // Creating a child that is itself a configured resource is its provider's job.
      (!projectCall && (verb === "create" || verb === "insert") && ownCollections.has(cols.at(-1)))
    ) {
      results.push({ id, kind: "lifecycle" });
      continue;
    }
    const scoped = cols.filter((c) => !SCOPE_COLLECTIONS.has(c));
    const permission =
      config.permissions?.[id] ??
      [verb === "patch" ? "update" : verb, verb]
        // Only the method's own collection: a parent's permission
        // (`databases.create` for creating an index) is a different action.
        // Some services lowercase it (`artifactregistry.dockerimages.get`).
        .flatMap((v) =>
          scoped.length === 0
            ? []
            : [scoped.at(-1)!, scoped.at(-1)!.toLowerCase()].map(
                (c) => `${permissionService}.${c}.${v}`,
              ),
        )
        .find((p) => roles[p] !== undefined);
    if (permission === undefined || roles[permission] === undefined) {
      results.push({ id, kind: "needs-permission", reason: permission });
      continue;
    }
    const types = parseOperation(moduleSource, fn);
    if (types === undefined) {
      results.push({ id, kind: "project", reason: `no distilled operation ${fn}` });
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
    const name = config.names?.[derived] ?? derived;
    const binding = bindings.get(name) ?? {
      name,
      verb,
      description: (method.description ?? "").split(/(?<=\.)\s/)[0] ?? "",
      variants: [],
    };
    if (
      binding.variants.some((v) => v.resource === resource.key) ||
      binding.variants.some((v) => (v.scope === undefined) !== (scope === undefined))
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
      scope,
      projectField:
        scope !== undefined && target.param === undefined ? target.params![0] : undefined,
      children,
      suffix: config.suffix?.[id],
      append: config.append?.[id],
      grantOn: config.grantOn?.[id],
      projectGrant: config.projectGrant?.[id],
      permission,
      role: roles[permission]!,
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
  const omitted = [first.param ?? first.projectField!];
  const required = requiredMembers(first.api.moduleSource, first.types.request).filter(
    (m) => !omitted.includes(m),
  );
  const optional = required.length === 0 && (!located || global);
  const locationField = located
    ? ` {\n  /** Location to call in (\`projects/{project}/locations/{location}\`)${global ? "; the project itself when omitted" : ""}. */\n  location${global ? "?" : ""}: string;\n}`
    : " {}";
  const responses = [...new Set(binding.variants.map((v) => `${v.api.ns}.${v.types.response}`))];
  const errors = [...new Set(binding.variants.map((v) => `${v.api.ns}.${v.types.error}`))];
  const variable = binding.name[0]!.toLowerCase() + binding.name.slice(1);
  const grants = [...new Set(binding.variants.map((v) => `\`${v.role}\``))].join(", ");
  const exampleFields = [
    ...(located && !global ? ['location: "us-central1"'] : []),
    ...required.map((f) => `${f}: ${f === "body" ? "{}" : `"..."`}`),
  ];
  return `${HEADER(service)}${apiImports(binding, true)}
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

export interface ${binding.name}Request
  extends Omit<${first.api.ns}.${first.types.request}, ${omitted.map((o) => `"${o}"`).join(" | ")}>${locationField}

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
      ${v.param !== undefined ? `param: "${v.param}",` : `projectField: "${v.projectField}",`}${v.scope === "location" ? "\n      location: true," : ""}
      role: "${v.role}",
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

const emitContract = (service: string, config: ServiceConfig, binding: Binding) => {
  if (binding.variants[0]!.scope !== undefined) return emitProjectContract(service, binding);
  const first = binding.variants[0]!;
  const moduleSource = first.api.moduleSource;
  const resourceTypes = [...new Set(binding.variants.map((v) => v.resource))];
  const childFields = [
    ...first.children.map(([, field]) => field),
    ...(first.suffix ? [first.suffix[1]] : []),
  ];
  const omitted = first.param !== undefined ? [first.param] : Object.keys(first.params ?? {});
  const required = requiredMembers(moduleSource, first.types.request).filter(
    (m) => !omitted.includes(m),
  );
  const optional = required.length === 0 && childFields.length === 0;
  const fieldDocs = [
    ...first.children.map(([collection, field]) => [
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
  const variable = binding.name[0]!.toLowerCase() + binding.name.slice(1);
  const grants = [...new Set(binding.variants.map((v) => `\`${v.role}\``))].join(", ");
  return `${HEADER(service)}${apiImports(binding, true)}
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
${resourceTypes.map((r) => `import type { ${r} } from "./${r}.ts";`).join("\n")}

export interface ${binding.name}Request
  extends Omit<${first.api.ns}.${first.types.request}, ${omitted.map((o) => `"${o}"`).join(" | ")}>${childType}

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
 * const ${variable} = yield* GCP.${service}.${binding.name}(${resourceTypes[0]![0]!.toLowerCase() + resourceTypes[0]!.slice(1)});
 * const response = yield* ${variable}(${optional ? "" : `{ ${[...childFields.map((f) => `${f}: "..."`), ...required.map((f) => `${f}: ${f === "body" ? "{}" : `"..."`}`)].join(", ")} }`});
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

const emitHttp = (service: string, config: ServiceConfig, binding: Binding) => {
  if (binding.variants[0]!.scope !== undefined) return emitProjectHttp(service, binding);
  const variants = binding.variants.map((v) => {
    const resource = config.resources[v.resource]!;
    const type = resource.type ?? `GCP.${service}.${v.resource}`;
    const iamKind = v.projectGrant ? undefined : v.grantOn ? v.grantOn.iamKind : resource.iamKind;
    const iam = iamKind
      ? `{ role: "${v.role}", on: "${iamKind}" }`
      : resource.scopeByCondition && !v.projectGrant
        ? `{ role: "${v.role}", scopeByCondition: true }`
        : `{ role: "${v.role}" }`;
    const children =
      (v.children.length
        ? `\n      children: [${v.children.map(([c, f]) => `["${c}", "${f}"]`).join(", ")}],`
        : "") +
      (v.suffix ? `\n      suffix: ["${v.suffix[0]}", "${v.suffix[1]}"],` : "") +
      (v.append ? `\n      append: "${v.append}",` : "") +
      (v.grantOn ? `\n      grantOn: "${v.grantOn.attribute}",` : "");
    return `    {
      resource: "${type}",
      operation: ${v.api.ns}.${v.fn},
      ${v.param !== undefined ? `param: "${v.param}",` : `params: ${JSON.stringify(v.params)},`}${children}
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
const emitAuditLogs = (
  service: string,
  key: string,
  resource: ResourceConfig,
  serviceNames: readonly string[],
) => {
  const variable = key[0]!.toLowerCase() + key.slice(1);
  const type = resource.type ?? `GCP.${service}.${key}`;
  return `${HEADER(service)}import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import {
  AuditLogEventSource,
  resourceAuditLogFilter,
  type AuditLogEventSourceProps,
  type AuditLogEventsHandler,
} from "../Logging/AuditLogEventSource.ts";
import type { ${key} } from "./${key}.ts";

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
            filter: Output.map(resource.name, (resourceName) =>
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
  // A child with no IAM of its own is covered by its parent's audit logs
  // (the filter matches the parent and everything below it).
  for (const [key, resource] of Object.entries(config.resources).filter(
    ([, resource]) => !resource.lifecycleOnly,
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
    `${HEADER(service)}${[
      ...bindings.flatMap((b) => [`./${b.name}.ts`, `./${b.name}Http.ts`]),
      ...auditLogs.map((file) => `./${file}`),
    ]
      .map((file) => `export * from "${file}";`)
      .join("\n")}\n`,
  );
  const indexPath = path.join(serviceDir, "index.ts");
  const index = yield* fs.readFileString(indexPath);
  if (!index.includes(`"./generated.ts"`)) {
    yield* fs.writeFileString(indexPath, `${index.trimEnd()}\nexport * from "./generated.ts";\n`);
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
      ],
      { cwd: root, stdin: "ignore", stderr: "ignore" },
    ),
  );
});

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
        ChildProcess.make("git", ["status", "--porcelain", "--", "packages/gcp"], {
          cwd: root,
          stdin: "ignore",
        }),
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
