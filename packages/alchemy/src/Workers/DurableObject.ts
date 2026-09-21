/** Shared Durable Object registration and export mechanics. @internal */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RpcErrorClass } from "../Rpc.ts";
import * as Option from "effect/Option";
import * as Binding from "../Binding.ts";
import type { Input } from "../Input.ts";
import { ALCHEMY_PHASE } from "../Phase.ts";
import { effectClass, taggedFunction } from "../Util/effect.ts";
import { WorkerEnvironment } from "./Worker.ts";

// ---------------------------------------------------------------------------
// The instance shape and the export record a host publishes per class
// ---------------------------------------------------------------------------

/** Erased only at the heterogeneous export/dispatch boundary. */
export interface DurableObjectShape {
  fetch?: Effect.Effect<any, any, any>;
  alarm?: (...args: any[]) => Effect.Effect<any, any, any>;
  webSocketOpen?: (...args: any[]) => Effect.Effect<any, any, any>;
  webSocketMessage?: (...args: any[]) => Effect.Effect<any, any, any>;
  webSocketClose?: (...args: any[]) => Effect.Effect<any, any, any>;
  webSocketError?: (...args: any[]) => Effect.Effect<any, any, any>;
}

export interface DurableObjectExport<Shape = any> {
  readonly kind: "durableObject";
  readonly provider: string;
  readonly constructor: Effect.Effect<
    Effect.Effect<Shape, never, any>,
    never,
    any
  >;
  readonly services: Context.Context<never>;
}

export const isDurableObjectExport = (
  value: unknown,
): value is DurableObjectExport =>
  typeof value === "object" && (value as any)?.kind === "durableObject";

// ---------------------------------------------------------------------------
// Hosting: the seam between a class declaration and the worker hosting it
// ---------------------------------------------------------------------------

/** A Durable Object class declaration as registered on its hosting worker. */
export interface DurableObjectBindingDeclaration {
  /** Binding name — the Durable Object's logical id. */
  readonly name: string;
  /** The exported class name backing the binding. */
  readonly className: string;
  /** Foreign hosting script, for cross-script bindings. */
  readonly scriptName?: Input<string> | undefined;
  /** Normalized former-host identifiers driving a transfer migration. */
  readonly transferredFrom?: Input<string>[] | undefined;
}

/**
 * The least a native namespace stub must offer the engine's stub flavor:
 * an HTTP entry (workerd and celld stubs are fetchers). An engine whose
 * runtime environment hands back finished stubs (Rivet) satisfies it
 * trivially.
 */
export interface DurableObjectStubLike {
  readonly fetch?: (
    input: string | URL | globalThis.Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/** The native namespace binding found under the class name in the runtime environment. */
export interface DurableObjectNamespaceLike {
  getByName(name: string, options?: unknown): DurableObjectStubLike;
}

/**
 * The shape of a resource that can HOST Durable Objects: any native worker
 * resource (Cloudflare / Celld / Rivet) — a `Platform()`-built instance
 * whose runtime context exposes `export` alongside the resource's `bind`.
 * Non-worker hosts (Lambda Functions, ECS tasks) have `bind` but no
 * `export`, which is what routes them to the remote-caller path.
 *
 * The two flavor members are the per-engine variation points, assigned by
 * an engine's `createRuntimeContext`.
 */
export interface DurableObjectHostLike {
  readonly Type: string;
  readonly LogicalId: string;
  readonly bind: (
    template: TemplateStringsArray,
    ...args: any[]
  ) => (data: any) => Effect.Effect<void>;
  readonly export: (name: string, value: any) => Effect.Effect<void>;
  /**
   * Host-native binding data for a Durable Object class declaration —
   * what `host.bind` receives when a hosted DO layer registers itself
   * (Cloudflare: `{ bindings: [{ type: "durable_object_namespace", … }] }`;
   * Celld / Rivet: `{ durableObjects: [{ name, className }] }`).
   */
  readonly durableObjectBinding: (
    decl: DurableObjectBindingDeclaration,
  ) => unknown;
  /**
   * The engine's stub flavor over an instance stub selected from the
   * runtime environment's native namespace binding (workerd wraps the
   * JSRPC stub, celld wraps with the fetch-RPC transport, Rivet's synthetic
   * env already returns finished stubs).
   */
  readonly durableObjectStub: (
    nativeStub: DurableObjectStubLike,
    namespace: string,
    options: DurableObjectStubOptions,
  ) => unknown;
}

/** Per-class options a host's stub flavor honors. */
export interface DurableObjectStubOptions {
  /**
   * Tagged-error classes the class's RPC methods can fail with: failures
   * crossing the RPC boundary are reconstructed as real instances (see
   * `RpcErrorClass` in `Rpc.ts`).
   */
  readonly errors?: ReadonlyArray<RpcErrorClass> | undefined;
}

export const isDurableObjectHost = (
  value: unknown,
): value is DurableObjectHostLike =>
  (typeof value === "object" || typeof value === "function") &&
  value !== null &&
  // `in` first: a resource proxy answers property READS for any attribute
  // name with a callable `PropExpr` Output accessor, so `typeof
  // host.export === "function"` alone is true for EVERY resource (a
  // Lambda included). `in` forwards to the proxy target and only reports
  // properties that really exist (`export` and the flavors are
  // Object.assigned onto worker instances by their runtime context; refs
  // report nothing).
  "bind" in (value as object) &&
  "export" in (value as object) &&
  "durableObjectBinding" in (value as object) &&
  "durableObjectStub" in (value as object) &&
  typeof (value as { bind?: unknown }).bind === "function" &&
  typeof (value as { export?: unknown }).export === "function";

/**
 * The Durable Object hosting core — ONE implementation of "register the
 * class on its hosting worker and export it". Binding registration,
 * runtime-env namespace resolution, the plan-time mock-state evaluation
 * that discovers transitive bindings, and the class export are
 * engine-invariant; the binding data shape and the stub flavor come from
 * the host.
 */
export const makeDurableObjectHosting = (
  namespace: string,
  provider: string,
) => {
  const register = (
    host: DurableObjectHostLike,
    decl: Omit<DurableObjectBindingDeclaration, "name">,
  ) =>
    Effect.gen(function* () {
      const declaration: DurableObjectBindingDeclaration = {
        name: namespace,
        ...decl,
      };
      // Binding data is HOST-NATIVE: the host's runtime context shapes the
      // declaration for its platform's worker binding contract.
      yield* host.bind`${namespace}`(host.durableObjectBinding(declaration));

      const native = yield* Effect.all([
        Effect.serviceOption(WorkerEnvironment).pipe(
          Effect.map(Option.getOrUndefined),
        ),
        ALCHEMY_PHASE,
      ]).pipe(
        Effect.flatMap(
          ([env, phase]): Effect.Effect<
            DurableObjectNamespaceLike | undefined
          > => {
            if (env === undefined || phase === "plan") {
              // only undefined at plan time — nothing to call yet
              return Effect.succeed(undefined);
            }
            const ns: unknown = env[namespace];
            if (!ns) {
              return Effect.die(
                new Error(
                  `DurableObject '${namespace}' not found in the worker environment`,
                ),
              );
            }
            if (
              typeof ns !== "object" ||
              !("getByName" in ns) ||
              typeof ns.getByName !== "function"
            ) {
              return Effect.die(
                new Error(
                  `DurableObject '${namespace}' is not a DurableObject`,
                ),
              );
            }
            return Effect.succeed(ns as DurableObjectNamespaceLike);
          },
        ),
      );

      const stub = (
        nativeStub: DurableObjectStubLike,
        options: DurableObjectStubOptions = {},
      ) => host.durableObjectStub(nativeStub, namespace, options);
      return { native, stub } as const;
    });

  const exportClass = (
    host: DurableObjectHostLike,
    constructor: DurableObjectExport["constructor"],
    planContext: Context.Context<any>,
  ) =>
    Effect.gen(function* () {
      const phase = yield* ALCHEMY_PHASE;
      if (phase === "plan") {
        // Evaluate the init phase with a mock state at plan time so
        // transitive bindings the object depends on are discovered and
        // registered on the worker.
        yield* constructor.pipe(Effect.provide(planContext));
      }
      // `export` lives on the runtime context assigned onto the instance —
      // present at both plan and runtime, but not part of the resource type.
      yield* host.export(namespace, {
        kind: "durableObject",
        provider,
        // initialize the object's constructor (apply infra dependencies)
        constructor,
        // grab the object's infra dependencies so we can apply them when
        // calling the instance's methods
        services: yield* Effect.context<never>(),
      } satisfies DurableObjectExport);
    });

  return { register, exportClass };
};

/** Resolve the ambient hosting worker and reject cross-provider declarations. */
export const requireDurableObjectHost = (namespace: string, provider: string) =>
  Effect.flatMap(Binding.Host, (host) =>
    isDurableObjectHost(host) && host.Type === provider
      ? Effect.succeed(host)
      : Effect.die(
          new Error(
            `DurableObject '${namespace}' requires a ${provider} host; ` +
              `received ${host?.Type ?? "no Worker"}.`,
          ),
        ),
  );

/** Planning may compose deferred state Effects, but cannot execute state operations. */
export const durableObjectPlanContext = <I, S>(
  tag: Context.Service<I, S>,
  effectProperties: readonly (keyof S)[] = [],
): Context.Context<I> => {
  const reference = (path: string): unknown =>
    new Proxy(() => {}, {
      get: (_target, key) =>
        path === tag.key && effectProperties.includes(key as keyof S)
          ? Effect.die(
              new Error(`${path}.${String(key)} can only be called at runtime`),
            )
          : reference(`${path}.${String(key)}`),
      apply: () => {
        const error = new Error(`${path} can only be called at runtime`);
        if (
          path
            .split(".")
            .some((key) => ["raw", "kv", "id", "container"].includes(key))
        ) {
          throw error;
        }
        return Effect.die(error);
      },
    });
  return Context.make(tag, reference(tag.key) as S);
};

/** Class/layer mechanics for providers with local, named namespaces. */
export const makeDurableObjectDeclaration = (
  scope: Context.ServiceClass<any, any, any>,
  options: {
    kind: string;
    provider: string;
    planContext: Context.Context<any>;
  },
) => {
  const declaration = taggedFunction(
    scope,
    function (
      name?: string,
      propsOrImpl?: DurableObjectStubOptions | Effect.Effect<any, never, any>,
      classForm = false,
    ): any {
      if (name === undefined) {
        return (
          name: string,
          propsOrImpl?:
            | DurableObjectStubOptions
            | Effect.Effect<any, never, any>,
        ) => declaration(name, propsOrImpl, true);
      }
      const tag = Context.Service(`${options.kind}.${name}`);
      const hosting = makeDurableObjectHosting(name, options.provider);
      const props = Effect.isEffect(propsOrImpl) ? undefined : propsOrImpl;
      const make = (constructor: DurableObjectExport["constructor"]) =>
        Effect.gen(function* () {
          const host = yield* requireDurableObjectHost(name, options.provider);
          const { native, stub } = yield* hosting.register(host, {
            className: name,
          });
          const self = {
            kind: options.kind,
            Type: options.kind,
            name,
            getByName: (key: string) => {
              if (native === undefined) {
                throw new Error(
                  `DurableObject '${name}' can only be called at runtime`,
                );
              }
              return stub(native.getByName(key), props);
            },
          };
          yield* hosting.exportClass(
            host,
            constructor.pipe(Effect.provideService(scope, self)),
            options.planContext,
          );
          return self;
        });

      if (Effect.isEffect(propsOrImpl)) {
        return effectClass(
          make(
            classForm
              ? propsOrImpl
              : propsOrImpl.pipe(Effect.map(Effect.succeed)),
          ),
        );
      }
      return class extends effectClass(tag as Effect.Effect<any, never, any>) {
        static make = (constructor: DurableObjectExport["constructor"]) =>
          Layer.effect(tag, make(constructor));
      };
    },
  );
  return declaration;
};
