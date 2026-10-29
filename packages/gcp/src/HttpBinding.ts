import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { GcpEnvironment } from "./Environment.ts";
import * as GCPBindings from "./GCPBindings.ts";
import { type GcpIamGrant } from "./Host.ts";
import type { GcpIamResourceKind } from "./IamPolicy.ts";

/**
 * Distilled ops are `OperationMethod`s: resolve them once at Layer
 * construction through `GCPBindings.withCredentials`, so the inner runtime
 * Effect is `Effect<A, E>` and does not leak `GcpOpContext`. On a host that
 * runs as a service account its Layer provides Credentials/HttpClient; on
 * any other host `withCredentials` provides them from the created key.
 */
export type GcpHttpOp<I, A, E> = Effect.Effect<
  (input: I) => Effect.Effect<A, E>,
  never,
  GcpOpContext
> &
  ((input: I) => Effect.Effect<A, E, GcpOpContext>);

/**
 * IAM a binding grants the host's runtime service account on the bound
 * resource: `role` is the narrowest predefined role covering the
 * operation. With `on`, the role is granted on the bound resource's own
 * IAM policy (resource-scoped, like an AWS statement's `Resource: [arn]`);
 * without it — only for services that have no resource-level IAM — the
 * role is granted on the project.
 */
export interface BindingIam {
  role: string;
  on?: Exclude<GcpIamResourceKind, "project">;
  /**
   * For services with no per-resource IAM policy but IAM Conditions
   * support (Firestore, Cloud SQL, Managed Kafka): grant on the project
   * under a condition matching only the bound resource and its children.
   */
  scopeByCondition?: boolean;
  /**
   * More roles granted on the project alongside `role`, for operations
   * that also write somewhere the bound resource's grant doesn't reach
   * (a de-identify fills a destination dataset it creates).
   */
  also?: string[];
}

const nameExpression = (value: string) =>
  `resource.name == "${value}" || resource.name.startsWith("${value}/")`;

/** IAM Condition matching one resource (by full name) and its children. */
export const resourceNameCondition = (name: Input<string>) => ({
  title: "alchemy-scoped",
  expression:
    typeof name === "string"
      ? nameExpression(name)
      : Output.map(name as Output.Output<string>, nameExpression),
});

/** Build the grant for `iam` against a bound resource's full name. */
export const grantFor = (iam: BindingIam, name: Input<string>): Input<GcpIamGrant> =>
  iam.on !== undefined
    ? // The engine resolves the name Output before the host reconciles.
      { role: iam.role, resource: { kind: iam.on, name } }
    : iam.scopeByCondition
      ? { role: iam.role, condition: resourceNameCondition(name) }
      : { role: iam.role };

/** Every grant `iam` makes: its role on the resource, plus `also` on the project. */
export const grantsFor = (iam: BindingIam, name: Input<string>): Input<GcpIamGrant>[] => [
  grantFor(iam, name),
  ...(iam.also ?? []).map((role) => ({ role })),
];

/**
 * Shared HTTP scaffolding for GCP named-resource bindings.
 *
 * Yields the distilled operation (no double-provide) and, at deploy
 * time, grants `iam` on the ambient Cloud Run / Function host the way
 * AWS bindings attach IAM policy statements.
 */
export const makeNamedHttpBinding = <
  Resource extends { LogicalId: string },
  I extends { name?: string },
  A,
  E,
>(options: {
  tag: string;
  operation: GcpHttpOp<I, A, E>;
  iam: BindingIam;
  resourceName: (resource: Resource) => Output.Output<string, never>;
}) =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const run = yield* GCPBindings.withCredentials(options.operation);
    return Effect.fn(function* (resource: Resource) {
      const resourceName = options.resourceName(resource);
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${resource})`({
          iam: grantsFor(options.iam, resourceName),
        });
      }
      const name = yield* resourceName;
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Omit<I, "name">,
      ) {
        return yield* run({
          ...request,
          name: yield* name,
        } as I);
      });
    });
  });

/**
 * One way a generated binding reaches its operation: the resource type it
 * binds, the distilled operation, the request field the bound resource's
 * full name goes in, and the child segments appended from request fields.
 */
export interface GcpBindingVariant {
  /** Resource type this variant binds, e.g. `GCP.SecretManager.Secret`. */
  readonly resource: string;
  readonly operation: GcpHttpOp<any, any, any>;
  /** Request field that carries the target's full name, e.g. `name`. */
  readonly param?: string;
  /**
   * For APIs addressed by separate path parameters: request field → the
   * bound resource's attribute that fills it, e.g.
   * `{ projectId: "project", datasetId: "datasetId" }`.
   */
  readonly params?: Readonly<Record<string, string>>;
  /** IAM the host gets on the bound resource. */
  readonly iam: BindingIam;
  /**
   * Grant on another resource the bound one names, through this attribute:
   * detaching a subscription is authorized on its `topic`.
   */
  readonly grantOn?: string;
  /**
   * Child segments under the bound resource, as `[collection, field]`:
   * `[["versions", "version"]]` turns a bound secret and
   * `{ version: "3" }` into `…/secrets/s/versions/3`.
   */
  readonly children?: ReadonlyArray<readonly [collection: string, field: string]>;
  /**
   * Appended to the target after the children, from a request field:
   * `["@", "revisionId"]` targets `…/schemas/s@<revisionId>`.
   */
  readonly suffix?: readonly [separator: string, field: string];
  /**
   * A fixed path after the bound resource's name, for targets that aren't a
   * child resource: Firestore queries run on `…/databases/d/documents`.
   */
  readonly append?: string;
}

/**
 * Shared scaffolding for generated GCP bindings (see
 * `scripts/generate-gcp-bindings.ts`). Picks the variant for the bound
 * resource's type, grants its `iam` on the resource at deploy time, and
 * injects the resource's full name (plus child segments) into each request
 * at runtime.
 */
export const makeGcpBinding = <Shape>(options: {
  tag: string;
  variants: ReadonlyArray<GcpBindingVariant>;
}): Effect.Effect<Shape> =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const runs = yield* Effect.forEach(options.variants, (variant) =>
      GCPBindings.withCredentials(variant.operation as Effect.Effect<any, never, any>),
    );
    const bindResource = Effect.fn(function* (resource: { Type: string; LogicalId: string }) {
      const index = Math.max(
        0,
        options.variants.findIndex((variant) => variant.resource === resource.Type),
      );
      const variant = options.variants[index]!;
      const run = runs[index] as (input: unknown) => Effect.Effect<unknown, unknown>;
      const attributes = resource as unknown as Record<string, Output.Output<string, never>>;
      const resourceName = attributes.name!;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${resource})`({
          iam: grantsFor(variant.iam, attributes[variant.grantOn ?? "name"]!),
        });
      }
      // Flat-path variants address the resource by `params` alone.
      const name = variant.param !== undefined ? yield* resourceName : undefined;
      const filled: [string, Effect.Effect<string>][] = [];
      for (const [field, attribute] of Object.entries(variant.params ?? {})) {
        filled.push([field, yield* attributes[attribute]!]);
      }
      return Effect.fn(`${options.tag}(${resource.LogicalId})`)(function* (
        request?: Record<string, unknown>,
      ) {
        const input: Record<string, unknown> = { ...request };
        let target = name === undefined ? "" : yield* name;
        if (variant.append) target = `${target}/${variant.append}`;
        for (const [collection, field] of variant.children ?? []) {
          // A trailing singleton (`…/certificateAuthority`) has no field.
          target =
            field === "" ? `${target}/${collection}` : `${target}/${collection}/${input[field]}`;
          delete input[field];
        }
        if (variant.suffix) {
          const [separator, field] = variant.suffix;
          target = `${target}${separator}${input[field]}`;
          delete input[field];
        }
        if (variant.param !== undefined) input[variant.param] = target;
        for (const [field, value] of filled) input[field] = yield* value;
        return yield* run(input);
      });
    });
    // The generated contract declares the precise request/response types.
    return bindResource as unknown as Shape;
  });

/** One way a project-scoped binding calls its operation. */
export interface GcpProjectBindingVariant {
  readonly operation: GcpHttpOp<any, any, any>;
  /**
   * Request field the scope's name goes in (`projects/{project}`, or
   * `projects/{project}/locations/{location}` when `location`), e.g. `parent`.
   */
  readonly param?: string;
  /** For APIs addressed by separate path parameters: the project-id field, e.g. `projectId`. */
  readonly projectField?: string;
  /** The scope is a location: the request's `location` field names it. */
  readonly location?: boolean;
  /**
   * Child segments under the scope, as `[collection, field]`, for a
   * resource Alchemy doesn't manage: `[["clusters", "cluster"]]` turns
   * `{ location: "us-central1", cluster: "c" }` into
   * `projects/p/locations/us-central1/clusters/c`.
   */
  readonly children?: ReadonlyArray<readonly [collection: string, field: string]>;
  /** Role the host gets on the project. */
  readonly role: string;
  /** More roles granted on the project alongside `role`. */
  readonly also?: readonly string[];
}

/** The project a project-scoped binding was deployed against was not handed to the host. */
export class GcpBindingProjectMissing extends Data.TaggedError("GCP.BindingProjectMissing")<{
  tag: string;
}> {}

const PROJECT_KEY = "ALCHEMY_GCP_BINDING_PROJECT";

/**
 * The project a host's project bindings were deployed against, at runtime;
 * `undefined` on a host with no project binding.
 */
export const bindingProject: Effect.Effect<string | undefined> = Effect.gen(function* () {
  const ctx = yield* CurrentRuntimeContext;
  return ctx === undefined ? undefined : yield* ctx.get<string>(PROJECT_KEY);
});

/**
 * Runtime of a generated binding for an operation on the project itself
 * (`topics.list`, `jobs.insert`), which has no resource to bind to: the
 * host gets each variant's role on the stack's project, and the project id
 * is handed to the host at deploy. A variant with `location` runs when the
 * request names a `location`, the others when it doesn't.
 */
export const makeGcpProjectBinding = <Shape>(options: {
  tag: string;
  variants: ReadonlyArray<GcpProjectBindingVariant>;
}): Effect.Effect<Shape> =>
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const ctx = yield* CurrentRuntimeContext;
    const runs = yield* Effect.forEach(options.variants, (variant) =>
      GCPBindings.withCredentials(variant.operation as Effect.Effect<any, never, any>),
    );
    const bindProject = Effect.fn(function* () {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const { project } = yield* GcpEnvironment.current;
        yield* bind`${options.tag}(${{ LogicalId: "project" }})`({
          iam: [...new Set(options.variants.flatMap((variant) => [variant.role, ...(variant.also ?? [])]))].map((role) => ({
            role,
          })),
          env: { [PROJECT_KEY]: project },
        });
      }
      return Effect.fn(options.tag)(function* (request?: Record<string, unknown>) {
        const project = ctx === undefined ? undefined : yield* ctx.get<string>(PROJECT_KEY);
        if (project === undefined) {
          return yield* new GcpBindingProjectMissing({ tag: options.tag });
        }
        const input: Record<string, unknown> = { ...request };
        const location = input.location as string | undefined;
        const index = Math.max(
          0,
          options.variants.findIndex(
            (variant) => (variant.location ?? false) === (location !== undefined),
          ),
        );
        const variant = options.variants[index]!;
        const run = runs[index] as (input: unknown) => Effect.Effect<unknown, unknown>;
        if (variant.location) delete input.location;
        if (variant.param !== undefined) {
          let target = variant.location
            ? `projects/${project}/locations/${location}`
            : `projects/${project}`;
          for (const [collection, field] of variant.children ?? []) {
            target =
              field === "" ? `${target}/${collection}` : `${target}/${collection}/${input[field]}`;
            delete input[field];
          }
          input[variant.param] = target;
        }
        if (variant.projectField !== undefined) input[variant.projectField] = project;
        return yield* run(input);
      });
    });
    // The generated contract declares the precise request/response types.
    return bindProject as unknown as Shape;
  });
