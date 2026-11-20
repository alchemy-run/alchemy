import type { ProviderCollectionLike } from "alchemy/Provider";
import {
  type BaseRuntimeContext,
  RuntimeContext,
  unpackEnvValue,
  unwrapRedactedMarker,
} from "alchemy/RuntimeContext";
import type { Stack } from "alchemy/Stack";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import type {
  GenericActionCtx,
  GenericMutationCtx,
  GenericQueryCtx,
  RegisteredAction,
  RegisteredMutation,
  RegisteredQuery,
} from "convex/server";
import {
  actionGeneric,
  internalActionGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  mutationGeneric,
  queryGeneric,
} from "convex/server";
import { ConvexError, type Value } from "convex/values";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EffectScheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  Auth,
  type FunctionDeclaration,
  type FunctionKind,
  type Handler,
  Reader,
  Runner,
  Scheduler,
  type ServicesOf,
  Writer,
} from "./Function.ts";
import { fields, validator } from "./Value.ts";

type AnyCtx = GenericQueryCtx<any> &
  Partial<GenericMutationCtx<any>> &
  Partial<GenericActionCtx<any>>;

/** One memo map and scope per isolate: a Layer is built once and shared by every function that uses it. */
const memoMap = Layer.makeMemoMapUnsafe();
const isolateScope = Scope.makeUnsafe();

/**
 * Queries and mutations run deterministically, and Convex limits their
 * timers. A fiber that yields resumes on a microtask instead of a timer.
 */
const deterministic = new EffectScheduler.MixedScheduler("sync");

/**
 * `Config` over the deployment's environment variables. Effect's default
 * provider reads `import.meta`, which Convex's runtime lacks, and lists
 * `process.env`, which Convex only answers by name. So each name is read
 * on its own: `Config.String("API_URL")` reads `process.env.API_URL`, with
 * a value `Convex.Functions` bound from a constructor's `Config` unwrapped.
 */
const deploymentVariables = ConfigProvider.make((path) => {
  const value = process.env[path.map(String).join("_")];
  // A secret Alchemy set is marker-packed; Config reads the plain value.
  return Effect.succeed(
    value === undefined || value === ""
      ? undefined
      : ConfigProvider.makeValue(unwrapRedactedMarker(value)),
  );
});

/**
 * The services a function of `kind` runs with. The handler's type only lets
 * it ask for these, so the context covers what it needs.
 */
/**
 * What Alchemy bindings read at runtime: the variables `Convex.Functions`
 * set on the deployment when it ran the constructors at deploy.
 */
const runtimeContext: BaseRuntimeContext = {
  Type: "Convex.Functions",
  id: "Convex.Functions",
  env: {},
  get: <T>(key: string) => Effect.sync(() => unpackEnvValue<T>(process.env[key])),
  // `yield* output` sets, then gets. The value was set at deploy, so setting
  // here only names the key.
  set: (key) => Effect.succeed(key),
};

/**
 * What a constructor may require beyond its own Layers: the providers of the
 * resources it declares, which only deploy uses, and the stack.
 */
export type DeclarationServices = ProviderCollectionLike | Stack | Stage;

/**
 * The services a constructor resolves resources and bindings with: the
 * runtime context, and the stack `Convex.Functions` deployed it from.
 */
const runtimeServices = () => {
  const name = process.env.ALCHEMY_STACK_NAME;
  const stage = process.env.ALCHEMY_STAGE;
  return Layer.mergeAll(
    Layer.succeed(RuntimeContext, runtimeContext),
    name === undefined || stage === undefined
      ? Layer.empty
      : Layer.mergeAll(
          Layer.succeed(StackContext, { name, stage, bindings: {}, resources: {}, actions: {} }),
          Layer.succeed(Stage, stage),
        ),
  );
};

const servicesOf = (
  kind: FunctionDeclaration["kind"],
  ctx: AnyCtx,
): Context.Context<ServicesOf<FunctionKind>> => {
  const auth = Context.make(Auth, ctx.auth);
  switch (kind) {
    case "query":
      return Context.add(auth, Reader, ctx.db) as Context.Context<ServicesOf<FunctionKind>>;
    case "mutation":
      return auth.pipe(
        Context.add(Reader, ctx.db),
        Context.add(Writer, ctx.db as GenericMutationCtx<any>["db"]),
        Context.add(Scheduler, ctx.scheduler!),
      ) as Context.Context<ServicesOf<FunctionKind>>;
    case "action":
      return auth.pipe(
        Context.add(Scheduler, ctx.scheduler!),
        Context.add(Runner, {
          runQuery: (reference, args) => ctx.runQuery!(reference, args),
          runMutation: (reference, args) => ctx.runMutation!(reference, args),
          runAction: (reference, args) => ctx.runAction!(reference, args),
        }),
        Context.add(RuntimeContext, runtimeContext),
      ) as Context.Context<ServicesOf<FunctionKind>>;
  }
};

type Visibility<F extends FunctionDeclaration> = F["internal"] extends true ? "internal" : "public";
type Encoded<S> = S extends Schema.Top ? S["Encoded"] : null;

/** The Convex function `serve` registers for a declaration. */
export type Served<F extends FunctionDeclaration> = F["kind"] extends "query"
  ? RegisteredQuery<Visibility<F>, F["args"]["Encoded"], Promise<Encoded<F["returns"]>>>
  : F["kind"] extends "mutation"
    ? RegisteredMutation<Visibility<F>, F["args"]["Encoded"], Promise<Encoded<F["returns"]>>>
    : RegisteredAction<Visibility<F>, F["args"]["Encoded"], Promise<Encoded<F["returns"]>>>;

const register = (kind: FunctionDeclaration["kind"], internal: boolean) => {
  switch (kind) {
    case "query":
      return internal ? internalQueryGeneric : queryGeneric;
    case "mutation":
      return internal ? internalMutationGeneric : mutationGeneric;
    case "action":
      return internal ? internalActionGeneric : actionGeneric;
  }
};

/** Turn a failed run into what Convex reports: a typed failure as `ConvexError`, a defect as an `Error`. */
const toThrown = (fn: FunctionDeclaration, cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    const failure = Cause.findErrorOption(cause);
    if (Option.isSome(failure) && fn.error !== undefined) {
      const data = yield* Schema.encodeUnknownEffect(fn.error)(failure.value).pipe(Effect.option);
      if (Option.isSome(data)) return new ConvexError(data.value as Value);
    }
    return new Error(Cause.pretty(cause));
  });

/**
 * Register a declared function with Convex, implemented by `layer`. Export
 * it from a file in `convex/` under the declaration's path: `messages:list`
 * is the `list` export of `convex/messages.ts`.
 *
 * Convex checks the arguments' encoded shape before the handler runs, and
 * the handler decodes them with the declaration's schema. A typed failure
 * reaches the caller as a `ConvexError` holding the encoded value, and rolls
 * a mutation back.
 *
 * The Layer is built once per Convex isolate, the first time any function
 * that uses it runs, and shared by every function it provides.
 *
 * ### Serving Functions
 * **Example:** `convex/messages.ts`
 * ```typescript
 * import { MessagesLive } from "../src/messages.live.ts";
 * import { AddMessage, ListMessages } from "../src/messages.ts";
 *
 * export const list = Convex.serve(ListMessages, MessagesLive);
 * export const add = Convex.serve(AddMessage, MessagesLive);
 * ```
 *
 * @primitive
 * @product Functions
 */
export const serve = <F extends FunctionDeclaration & Context.Key<any, any>>(
  fn: F,
  layer: Layer.Layer<F["Identifier"], unknown, DeclarationServices>,
): Served<F> => {
  const program = (ctx: AnyCtx, rawArgs: unknown) =>
    Effect.gen(function* () {
      const context = yield* Layer.buildWithMemoMap(
        // A binding's constructor reads what it bound at deploy from here.
        // Declaring a resource needs its provider only at deploy.
        Layer.provide(layer, runtimeServices()) as Layer.Layer<F["Identifier"], unknown, never>,
        memoMap,
        isolateScope,
      );
      const handler = Context.get(context, fn) as Handler<any, any, any, any>;
      const args = yield* Schema.decodeUnknownEffect(fn.args)(rawArgs).pipe(Effect.orDie);
      const value = yield* handler(args).pipe(Effect.provideContext(servicesOf(fn.kind, ctx)));
      return fn.returns === undefined
        ? null
        : yield* Schema.encodeEffect(fn.returns)(value).pipe(Effect.orDie);
    });

  const handler = async (ctx: AnyCtx, rawArgs: unknown) => {
    // Bindings check this to skip their deploy-time wiring. Set here, not at
    // import: the deploying program imports this module too.
    globalThis.__ALCHEMY_RUNTIME__ = true;
    const configured = program(ctx, rawArgs).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, deploymentVariables),
    );
    const exit = await Effect.runPromiseExit(
      fn.kind === "action"
        ? configured
        : configured.pipe(Effect.provideService(EffectScheduler.Scheduler, deterministic)),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    // Convex learns of a failure only by a throw: this is the boundary.
    throw await Effect.runPromise(toThrown(fn, exit.cause));
  };

  return register(
    fn.kind,
    fn.internal,
  )({
    args: fields(fn.args),
    ...(fn.returns === undefined ? {} : { returns: validator(fn.returns) }),
    handler,
  } as never) as unknown as Served<F>;
};
