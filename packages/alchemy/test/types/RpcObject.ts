import * as Cloudflare from "@/Cloudflare/index.ts";
import type { ObjectBody, R2Error } from "@/Cloudflare/R2/BucketTypes.ts";
import { makeRpcStub } from "@/Cloudflare/Workers/Rpc.ts";
import { Service } from "@/Docker/Service.ts";
import type { Rpc, RpcObject, ValidateRpcObject } from "@/Rpc.ts";
import type { ValidateRpcShape } from "@/RpcObject.ts";
import * as RpcPipeline from "@/RpcPipeline.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { Scope } from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

class Rejected extends Data.TaggedError("Rejected")<{ message: string }> {}
class MissingService extends Context.Service<
  MissingService,
  { readonly value: string }
>()("RpcObjectTest/MissingService") {}

function overloaded(value: string): Effect.Effect<string, Rejected>;
function overloaded(value: number): Effect.Effect<number, Rejected>;
function overloaded(
  value: string | number,
): Effect.Effect<string | number, Rejected> {
  return Effect.succeed(value);
}

const methods = {
  echo: <T>(value: T): Effect.Effect<T> => Effect.succeed(value),
  select: <Value, Key extends keyof Value>(
    value: Value,
    key: Key,
  ): Effect.Effect<Value[Key]> => Effect.succeed(value[key]),
  overloaded,
  values: <T>(value: T): Stream.Stream<T> => Stream.make(value),
  selectedValues: <Value, Key extends keyof Value>(
    value: Value,
    key: Key,
  ): Stream.Stream<Value[Key]> => Stream.make(value[key]),
  fail: () => Effect.fail(new Rejected({ message: "rejected" })),
  failValues: () => Stream.fail(new Rejected({ message: "rejected" })),
  scoped: () => Effect.as(Effect.scope, "scoped" as const),
  scopedValues: () =>
    Stream.fromEffect(Effect.as(Effect.scope, "scoped" as const)),
  contextual: (): Effect.Effect<"contextual", never, RuntimeContext> =>
    Effect.succeed("contextual"),
  contextualValues: (): Stream.Stream<
    "contextual",
    never,
    RuntimeContext | Scope
  > => Stream.make("contextual"),
} satisfies RpcObject;

const returned = {
  ...methods,
  child: () => Effect.succeed(methods),
} satisfies RpcObject;

const shape = {
  ...methods,
  fetch: Effect.succeed(HttpServerResponse.text("ok")),
  open: (): Effect.Effect<typeof returned, Rejected, Scope> =>
    Effect.succeed(returned),
  runtime: (): Effect.Effect<void, never, RuntimeContext> => Effect.void,
};
const props = { main: import.meta.url };

export const FunctionalWorker = Cloudflare.Worker(
  "RpcObjectFunctionalWorker",
  props,
  Effect.succeed(shape),
);

export class InferredWorker extends Cloudflare.Worker<InferredWorker>()(
  "RpcObjectInferredWorker",
  props,
  Effect.succeed(shape),
) {}

export class DeclaredWorker extends Cloudflare.Worker<
  DeclaredWorker,
  typeof shape
>()("RpcObjectDeclaredWorker") {}

export const DeclaredWorkerLive = DeclaredWorker.make(
  props,
  Effect.succeed(shape),
);

export const FunctionalObject = Cloudflare.DurableObject(
  "RpcObjectFunctionalObject",
  Effect.succeed(shape),
);

export class InferredObject extends Cloudflare.DurableObject<InferredObject>()(
  "RpcObjectInferredObject",
  Effect.succeed(Effect.succeed(shape)),
) {}

export class DeclaredObject extends Cloudflare.DurableObject<
  DeclaredObject,
  typeof shape
>()("RpcObjectDeclaredObject") {}

export const DeclaredObjectLive = DeclaredObject.make(
  Effect.succeed(Effect.succeed(shape)),
);

export const PlatformService = Service(
  "RpcObjectPlatformService",
  props,
  Effect.succeed(shape),
);

export class InferredService extends Service<InferredService>()(
  "RpcObjectInferredService",
  props,
  Effect.succeed(shape),
) {}

export class ForwardService extends Service<ForwardService>()(
  "RpcObjectForwardService",
) {}
export const ForwardServiceLive = ForwardService.make(
  props,
  Effect.succeed(shape),
);

export class DeclaredService extends Service<DeclaredService, typeof shape>()(
  "RpcObjectDeclaredService",
) {}
export const DeclaredServiceLive = DeclaredService.make(
  props,
  Effect.succeed(shape),
);

export type _WorkerPreservesShape = Assert<
  Equal<Rpc.Shape<typeof FunctionalWorker>, typeof shape>
>;
export type _PlatformPreservesShape = Assert<
  Equal<Rpc.Shape<typeof PlatformService>, typeof shape>
>;
export type _WorkerPreservesGeneric = Assert<
  Equal<InferredWorker["echo"], typeof methods.echo>
>;
export type _WorkerPreservesOverloads = Assert<
  Equal<InferredWorker["overloaded"], typeof overloaded>
>;
export type _WorkerPreservesGenericStream = Assert<
  Equal<InferredWorker["values"], typeof methods.values>
>;
export type _NestedPreservesGenericStream = Assert<
  Equal<
    Effect.Success<ReturnType<typeof shape.open>>["values"],
    typeof methods.values
  >
>;
export type _ObjectPreservesGeneric = Assert<
  Equal<InferredObject["select"], typeof methods.select>
>;
export type _ObjectPreservesOverloads = Assert<
  Equal<InferredObject["overloaded"], typeof overloaded>
>;
export type _PlatformPreservesGeneric = Assert<
  Equal<InferredService["echo"], typeof methods.echo>
>;
export type _FactoryKeepsScope = Assert<
  Equal<Effect.Services<ReturnType<typeof shape.open>>, Scope>
>;
export type _RootKeepsRuntimeContext = Assert<
  Equal<Effect.Services<ReturnType<InferredWorker["runtime"]>>, RuntimeContext>
>;
export type _ValidationDoesNotTransform = Assert<
  Equal<typeof returned & ValidateRpcObject<typeof returned>, typeof returned>
>;

const checkMethods = (client: typeof methods) => {
  const echo: Effect.Effect<"literal"> = client.echo("literal" as const);
  const selected: Effect.Effect<42> = client.select(
    { count: 42 as const },
    "count",
  );
  const text: Effect.Effect<string, Rejected> = client.overloaded("text");
  const number: Effect.Effect<number, Rejected> = client.overloaded(42);
  const values: Stream.Stream<"literal"> = client.values("literal" as const);
  const selectedValues: Stream.Stream<42> = client.selectedValues(
    { count: 42 as const },
    "count",
  );
  const failed: Effect.Effect<never, Rejected> = client.fail();
  const failedValues: Stream.Stream<never, Rejected> = client.failValues();
  const scoped: Effect.Effect<"scoped", never, Scope> = client.scoped();
  const scopedValues: Stream.Stream<"scoped", never, Scope> =
    client.scopedValues();
  const contextual: Effect.Effect<"contextual", never, RuntimeContext> =
    client.contextual();
  const contextualValues: Stream.Stream<
    "contextual",
    never,
    RuntimeContext | Scope
  > = client.contextualValues();
  // @ts-expect-error Generic correlation excludes keys absent from the value.
  client.select({ count: 42 }, "missing");
  // @ts-expect-error Stream methods preserve the same key/value correlation.
  client.selectedValues({ count: 42 }, "missing");
  // @ts-expect-error Neither overload accepts a boolean.
  client.overloaded(true);
  // @ts-expect-error Echo still requires its argument.
  client.echo();
  // @ts-expect-error Typed failures must not disappear.
  const infallible: Effect.Effect<never> = client.fail();
  // @ts-expect-error Stream failures must not disappear either.
  const infallibleValues: Stream.Stream<never> = client.failValues();
  // @ts-expect-error Scope must not disappear from the original method signature.
  const unscoped: Effect.Effect<"scoped"> = client.scoped();
  // @ts-expect-error A returned object has no RPC index signature.
  client.nonexistent();
  return {
    echo,
    selected,
    text,
    number,
    values,
    selectedValues,
    failed,
    failedValues,
    scoped,
    scopedValues,
    contextual,
    contextualValues,
  };
};

const checkRoot = (client: typeof shape) =>
  Effect.gen(function* () {
    checkMethods(client);
    const object = yield* client.open();
    checkMethods(object);
    checkMethods(yield* object.child());
    // @ts-expect-error Nested returned objects retain only their declared keys.
    object.nonexistent();
    // @ts-expect-error Root clients retain only their declared keys.
    client.nonexistent();
  });

export const BindingChecks = Effect.gen(function* () {
  const functional = yield* Cloudflare.Workers.bindWorker(FunctionalWorker);
  const inferred = yield* Cloudflare.Workers.bindWorker(InferredWorker);
  const declared = yield* Cloudflare.Workers.bindWorker(DeclaredWorker);
  checkRoot(functional);
  checkRoot(inferred);
  checkRoot(declared);
  // @ts-expect-error The inferred class must not inherit WorkerShape's index signature.
  inferred.nonexistent();
  // @ts-expect-error The explicit class must not inherit WorkerShape's index signature.
  declared.nonexistent();
  const functionalObject = (yield* FunctionalObject).getByName("object");
  const inferredObject = (yield* InferredObject).getByName("object");
  const declaredObject = (yield* DeclaredObject).getByName("object");
  checkMethods(functionalObject);
  checkMethods(inferredObject);
  checkMethods(declaredObject);
  checkMethods(yield* functionalObject.open());
  checkMethods(yield* inferredObject.open());
  checkMethods(yield* declaredObject.open());
  // @ts-expect-error Durable Object stubs do not acquire arbitrary RPC methods.
  inferredObject.nonexistent();
});

export const StubChecks = checkRoot(makeRpcStub<typeof shape>({}));

declare const headers: Headers;
declare const writable: WritableStream<Uint8Array>;
declare const objectBody: ObjectBody;
declare const databaseUrl: Redacted.Redacted<string>;

const dataMethods = {
  headers: () => Effect.succeed(headers),
  writable: () => Effect.succeed(writable),
  objectBody: () => Effect.succeed(objectBody),
  databaseUrl: () => Effect.succeed(databaseUrl),
} satisfies RpcObject;

const dataShape = {
  ...dataMethods,
  fetch: shape.fetch,
  get: (
    _key: string,
  ): Effect.Effect<ObjectBody | null, R2Error, RuntimeContext> =>
    Effect.succeed(objectBody),
  databaseUrl: (): Effect.Effect<
    Redacted.Redacted<string>,
    never,
    RuntimeContext
  > => Effect.succeed(databaseUrl),
  open: () => Effect.succeed(dataMethods),
};

export const DataWorker = Cloudflare.Worker(
  "RpcObjectDataWorker",
  props,
  Effect.succeed(dataShape),
);

export class DeclaredDataWorker extends Cloudflare.Worker<
  DeclaredDataWorker,
  typeof dataShape
>()("RpcObjectDeclaredDataWorker") {}
export const DeclaredDataWorkerLive = DeclaredDataWorker.make(
  props,
  Effect.succeed(DeclaredDataWorker.of(dataShape)),
);

export class DataObject extends Cloudflare.DurableObject<DataObject>()(
  "RpcObjectDataObject",
  Effect.succeed(Effect.succeed(dataShape)),
) {}

export const DataPlatform = Service(
  "RpcObjectDataPlatform",
  props,
  Effect.succeed(dataShape),
);

export type _HeadersAccepted = Assert<
  Equal<ValidateRpcObject<Headers>, unknown>
>;
export type _WritableStreamAccepted = Assert<
  Equal<ValidateRpcObject<WritableStream<Uint8Array>>, unknown>
>;
export type _ObjectBodyAccepted = Assert<
  Equal<ValidateRpcObject<ObjectBody>, unknown>
>;
export type _RedactedAccepted = Assert<
  Equal<ValidateRpcObject<Redacted.Redacted<string>>, unknown>
>;
export type _DataMethodsAccepted = Assert<
  Equal<ValidateRpcObject<typeof dataMethods>, unknown>
>;
export type _DataShapePreserved = Assert<
  Equal<Rpc.Shape<typeof DataWorker>, typeof dataShape>
>;
export type _ObjectBodyGenericPreserved = Assert<
  Equal<
    Effect.Success<ReturnType<DataObject["objectBody"]>>["json"],
    ObjectBody["json"]
  >
>;

const missing = { read: () => MissingService };
const missingStream = { read: () => Stream.fromEffect(MissingService) };
const sync = { read: () => "not an Effect" };
const promise = { read: () => Promise.resolve("not an Effect") };
const invalidShape = { ...shape, open: () => Effect.succeed(missing) };
const invalidStreamShape = {
  ...shape,
  open: () => Effect.succeed(missingStream),
};
const invalidSyncShape = { ...shape, open: () => Effect.succeed(sync) };
const invalidPromiseShape = { ...shape, open: () => Effect.succeed(promise) };
const invalidRecursiveShape = {
  ...shape,
  open: () => Effect.succeed({ child: () => Effect.succeed(missing) }),
};
const invalidImpl = Effect.succeed(invalidShape);
const invalidTwoStageImpl = Effect.succeed(invalidImpl);
const invalidStreamImpl = Effect.succeed(invalidStreamShape);
const invalidSyncImpl = Effect.succeed(invalidSyncShape);
const invalidPromiseImpl = Effect.succeed(invalidPromiseShape);
const invalidRecursiveImpl = Effect.succeed(invalidRecursiveShape);

// @ts-expect-error Returned Effect methods cannot require an unresolved service.
Cloudflare.Worker("MissingReturnedService", props, invalidImpl);
// @ts-expect-error Inferred Worker class implementations are validated too.
Cloudflare.Worker<never>()("MissingClassService", props, invalidImpl);
// @ts-expect-error Functional Durable Objects validate their inferred returned objects.
Cloudflare.DurableObject("MissingObjectService", invalidImpl);
// @ts-expect-error Inferred Durable Object classes validate through both init Effects.
Cloudflare.DurableObject<never>()("MissingClass", invalidTwoStageImpl);
// @ts-expect-error Functional Durable Objects also accept, and validate, two-stage init.
Cloudflare.DurableObject("MissingTwoStage", invalidTwoStageImpl);
// @ts-expect-error Shared Platform overloads validate returned objects.
Service("MissingPlatformService", props, invalidImpl);
// @ts-expect-error Inferred Platform classes validate returned objects.
Service<never>()("MissingPlatformClassService", props, invalidImpl);
// @ts-expect-error Forward Platform implementations must not widen away invalid methods.
ForwardService.make(props, invalidImpl);
// @ts-expect-error Stream methods cannot require unresolved services either.
Cloudflare.Worker("MissingStreamService", props, invalidStreamImpl);
// @ts-expect-error Sync methods are not Effect-native returned RPC methods.
Cloudflare.Worker("SyncReturnedMethod", props, invalidSyncImpl);
// @ts-expect-error Promise methods are not Effect-native returned RPC methods.
Cloudflare.Worker("PromiseReturnedMethod", props, invalidPromiseImpl);
// @ts-expect-error Validation follows successive returned RPC objects.
Cloudflare.Worker("MissingRecursiveService", props, invalidRecursiveImpl);

export class InvalidDeclaredWorker extends Cloudflare.Worker<
  InvalidDeclaredWorker,
  typeof invalidShape
>()("InvalidDeclaredWorker") {}
// @ts-expect-error Explicit Worker shapes are validated when implemented.
InvalidDeclaredWorker.make(props, invalidImpl);
// @ts-expect-error The explicit shape validation entry point rejects the same object.
InvalidDeclaredWorker.of(invalidShape);

export class InvalidDeclaredObject extends Cloudflare.DurableObject<
  InvalidDeclaredObject,
  typeof invalidShape
>()("InvalidDeclaredObject") {}
// @ts-expect-error Explicit Durable Object shapes are validated when implemented.
InvalidDeclaredObject.make(Effect.succeed(invalidImpl));

// @ts-expect-error The optional constraint rejects missing services without altering the shape.
missing satisfies RpcObject;
// @ts-expect-error The optional constraint rejects missing Stream services.
missingStream satisfies RpcObject;
// @ts-expect-error The optional constraint rejects synchronous methods.
sync satisfies RpcObject;
// @ts-expect-error The optional constraint rejects Promise methods.
promise satisfies RpcObject;

const missingWithRuntime = {
  read: () =>
    Effect.gen(function* () {
      yield* RuntimeContext;
      return yield* MissingService;
    }),
};
// @ts-expect-error RuntimeContext does not admit other unresolved services.
missingWithRuntime satisfies RpcObject;

export type _MissingRejected = Assert<
  Equal<ValidateRpcObject<typeof missing>, never>
>;
export type _UnionRejected = Assert<
  Equal<ValidateRpcObject<typeof methods | typeof missing>, never>
>;
export type _NestedMissingRejected = Assert<
  Equal<ValidateRpcShape<typeof invalidRecursiveShape>, never>
>;

declare const unionObject: typeof returned | typeof missing;
const unionImpl = Effect.succeed({ open: () => Effect.succeed(unionObject) });
// @ts-expect-error An invalid union branch cannot be hidden by a valid branch.
Cloudflare.Worker("MissingUnionService", props, unionImpl);

const rootServices = {
  runtime: (): Effect.Effect<void, never, RuntimeContext> => Effect.void,
  storage: (): Effect.Effect<void, never, Cloudflare.DurableObjectState> =>
    Effect.void,
};
export class RootServicesObject extends Cloudflare.DurableObject<RootServicesObject>()(
  "RootServicesObject",
  Effect.succeed(Effect.succeed(rootServices)),
) {}

// Opaque generics and earlier overloads cannot be inspected automatically.
const opaque = <T>(value: T): Effect.Effect<T> => Effect.succeed(value);
export type _OpaqueGenericRemainsGeneric = Assert<
  Equal<Rpc.Shape<typeof FunctionalWorker>["echo"], typeof opaque>
>;

// Returned objects may mix data with methods and nest methods at any depth.
const session = {
  id: "s1",
  createdAt: new Date(0),
  tags: ["a", "b"],
  increment: () => Effect.succeed(1),
  stats: {
    label: "visits",
    current: () => Effect.succeed(1),
    runtime: (): Effect.Effect<string, never, RuntimeContext> =>
      Effect.succeed("runtime"),
  },
  items: [
    { name: "a", bump: () => Effect.succeed("a" as const) },
    { name: "b", bump: () => Effect.succeed("b" as const) },
  ],
  echo: <T>(value: T): Effect.Effect<T> => Effect.succeed(value),
  overloaded,
  values: () => Stream.make(1, 2),
} satisfies RpcObject;

export type _MixedAccepted = Assert<
  Equal<ValidateRpcObject<typeof session>, unknown>
>;

type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { readonly [key: string]: Json };
export type _RecursiveJsonAccepted = Assert<
  Equal<ValidateRpcObject<{ doc: Json; list: Json[] }>, unknown>
>;

const nestedMissing = { data: 1, stats: { read: () => MissingService } };
const arrayMissing = { items: [{ read: () => MissingService }] };
const nestedSync = { data: 1, stats: { read: () => "not an Effect" } };
export type _NestedMissingInDataRejected = Assert<
  Equal<ValidateRpcObject<typeof nestedMissing>, never>
>;
export type _ArrayMissingRejected = Assert<
  Equal<ValidateRpcObject<typeof arrayMissing>, never>
>;
export type _NestedMethodObjectSyncRejected = Assert<
  Equal<ValidateRpcObject<typeof nestedSync>, never>
>;
// @ts-expect-error Nested Effect methods still cannot require unresolved services.
nestedMissing satisfies RpcObject;
// @ts-expect-error Methods inside arrays are checked too.
arrayMissing satisfies RpcObject;
// @ts-expect-error Nested method objects keep the strict Effect-or-Stream rule.
nestedSync satisfies RpcObject;

export const MixedWorker = Cloudflare.Worker(
  "RpcObjectMixedWorker",
  props,
  Effect.succeed({ open: () => Effect.succeed(session) }),
);
// @ts-expect-error Validation follows data fields to nested methods.
Cloudflare.Worker(
  "RpcObjectNestedMissing",
  props,
  Effect.succeed({ open: () => Effect.succeed(nestedMissing) }),
);

// Rpc.pipeline: data fields become Effects; methods keep their exact types.
declare const openSession: Effect.Effect<typeof session, Rejected>;

const piped = openSession.pipe(
  RpcPipeline.pipeline((s) =>
    Effect.all({
      id: s.id,
      when: s.createdAt,
      tag: s.tags[0],
      label: s.stats.label,
      current: s.stats.current(),
      runtime: s.stats.runtime(),
      bumped: s.items[1].bump(),
      echoed: s.echo("generic" as const),
      overloadedText: s.overloaded("text"),
    }),
  ),
);
export type _PipelineTypes = Assert<
  Equal<
    typeof piped,
    Effect.Effect<
      {
        id: string;
        when: Date;
        tag: string;
        label: string;
        current: number;
        runtime: string;
        bumped: "a" | "b";
        echoed: "generic";
        overloadedText: string;
      },
      Rejected,
      RuntimeContext
    >
  >
>;
export type _PipelineKeepsGenerics = Assert<
  Equal<RpcPipeline.Pending<typeof session>["echo"], typeof session.echo>
>;
export type _PipelineKeepsOverloads = Assert<
  Equal<RpcPipeline.Pending<typeof session>["overloaded"], typeof overloaded>
>;

const dataFirst = RpcPipeline.pipeline(openSession, (s) => s.items[0].bump());
export type _PipelineDataFirst = Assert<
  Equal<typeof dataFirst, Effect.Effect<"a" | "b", Rejected>>
>;

const wholeNested = openSession.pipe(RpcPipeline.pipeline((s) => s.stats));
export type _PipelineWholeNestedObject = Assert<
  Equal<Effect.Success<typeof wholeNested>, typeof session.stats>
>;

class ChildFailed extends Data.TaggedError("ChildFailed")<{}> {}
declare const openParent: Effect.Effect<
  {
    child: () => Effect.Effect<
      { echo: <T>(v: T) => Effect.Effect<T> },
      ChildFailed,
      Scope
    >;
  },
  Rejected
>;
const nestedPipeline = openParent.pipe(
  RpcPipeline.pipeline((parent) =>
    parent
      .child()
      .pipe(RpcPipeline.pipeline((child) => child.echo(1 as const))),
  ),
);
export type _NestedPipeline = Assert<
  Equal<typeof nestedPipeline, Effect.Effect<1, Rejected | ChildFailed>>
>;

export const _PendingDataIsNotPlain = (
  pending: RpcPipeline.Pending<typeof session>,
) => {
  // @ts-expect-error A pending data field is an Effect, not the value.
  const id: string = pending.id;
  return id;
};
