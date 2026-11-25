/**
 * The functions of the library the prover reads but does not run, each with
 * why: what it reports when the code calls one. A function on neither this
 * list nor the models is one the prover has not been taught yet, and a test
 * holds every module the prover reads to that.
 */

const OUTSIDE_PROMISE = "runs an effect outside the handler, for a promise";
const OUTSIDE_FIBER = "runs an effect outside the handler, on a fiber of its own";
const FIBER = "reads the running fiber, whose id is a count over the whole process";
const TRACING =
  "reads or sets the tracer's spans, which watch a handler and are not what it decides by";
const MACHINE_CLOCK = "measures with the machine's clock, not the handler's";
const WEB_STREAM = "reads or writes a Web stream, which is outside the handler";
const ASYNC_ITERABLE = "gives or goes over an async iterable, whose values come as promises";
const INTERNAL = "is internal to the library: its types do not export it";
const MEMO_MAP = "builds layers in a MemoMap, which is wiring";
const METRICS =
  "reads or registers the runtime's metrics, which watch a handler and are not what it decides by";
const EXECUTION_PLAN = "provides each step of an ExecutionPlan, which is wiring";

const each = (
  module: string,
  names: ReadonlyArray<string>,
  reason: string,
): ReadonlyArray<readonly [string, string]> =>
  names.map((name) => [`effect/${module}:${name}`, reason] as const);

/** Why each of these is reported, by `module:name`. */
export const JUDGED: ReadonlyMap<string, string> = new Map([
  ...each(
    "Effect",
    ["runPromise", "runPromiseExit", "runPromiseWith", "runPromiseExitWith"],
    OUTSIDE_PROMISE,
  ),
  ...each("Effect", ["runFork", "runForkWith", "runCallback", "runCallbackWith"], OUTSIDE_FIBER),
  ...each("Effect", ["promise", "tryPromise"], "waits for a promise, which is outside the handler"),
  ...each(
    "Effect",
    ["effectify"],
    "makes an effect of a Node callback, which is outside the handler",
  ),
  ...each(
    "Effect",
    ["abortSignal"],
    "gives an AbortSignal, which is the language's and not the handler's",
  ),
  ...each(
    "Effect",
    ["acquireDisposable"],
    "releases with Symbol.dispose, a method under a name the prover does not read",
  ),
  ...each(
    "Effect",
    ["Transaction"],
    "is the library's own record of a transaction: Effect.tx, which makes one, is supported",
  ),
  ...each("Effect", ["fiber", "fiberId", "withFiber", "withFiberSucceed"], FIBER),
  ...each("Fiber", ["getCurrent"], FIBER),
  ...each(
    "Effect",
    [
      "currentSpan",
      "currentParentSpan",
      "makeSpan",
      "makeSpanScoped",
      "useSpan",
      "spanAnnotations",
      "spanLinks",
      "linkSpans",
      "withParentSpan",
      "tracer",
      "withTracer",
    ],
    TRACING,
  ),
  ...each("Layer", ["span", "parentSpan", "withParentSpan"], TRACING),
  ...each("Effect", ["timed"], MACHINE_CLOCK),
  ...each("Sink", ["timed", "withDuration"], MACHINE_CLOCK),
  ...each(
    "Clock",
    ["monotonicTimeNanos"],
    "reads the machine's monotonic clock, which is not the handler's",
  ),
  ...each("Effect", ["withErrorReporting"], "reports errors to an ErrorReporter, which is wiring"),
  ...each("Effect", ["withLogger"], "logs with a Logger, which is wiring"),
  ...each("Effect", ["withExecutionPlan"], EXECUTION_PLAN),
  ...each("Stream", ["withExecutionPlan"], EXECUTION_PLAN),
  ...each(
    "Effect",
    ["requestUnsafe"],
    "runs a request outside the handler's fibers, on the context it is given",
  ),
  ...["FiberHandle", "FiberMap", "FiberSet"].flatMap((module) =>
    each(
      module,
      ["runtimePromise", "makeRuntimePromise"],
      "gives a function that runs an effect for a promise, outside the handler",
    ),
  ),
  ...each(
    "Cause",
    ["AsyncFiberError"],
    "is made of a fiber that Effect.runSync could not finish, and a fiber is the runtime's",
  ),
  ...each(
    "Cause",
    ["StackTrace", "InterruptorStackTrace"],
    "holds stack frames, which are the runtime's",
  ),
  ...each(
    "Cause",
    ["annotate", "annotations", "reasonAnnotations"],
    "reads or sets a cause's annotations, which hold the stack frames and spans the runtime adds",
  ),
  ...each(
    "Cause",
    ["interruptors", "filterInterruptors"],
    "reads the ids of the fibers that interrupted, each a count over the whole process",
  ),
  ...each(
    "Cause",
    ["pretty", "prettyErrors"],
    "renders a cause with its stack frames, which are the runtime's",
  ),
  ...each("Channel", ["fromAsyncIterable", "fromAsyncIterableArray"], ASYNC_ITERABLE),
  ...each("Stream", ["fromAsyncIterable"], ASYNC_ITERABLE),
  ...each(
    "Stream",
    ["toAsyncIterable", "toAsyncIterableEffect", "toAsyncIterableWith"],
    ASYNC_ITERABLE,
  ),
  ...each(
    "Channel",
    ["fromReadableStream", "fromTransformStream", "fromWritableStream", "pullIntoWritableStream"],
    WEB_STREAM,
  ),
  ...each(
    "Stream",
    ["fromReadableStream", "toReadableStream", "toReadableStreamEffect", "toReadableStreamWith"],
    WEB_STREAM,
  ),
  ...each("Sink", ["fromWritableStream"], WEB_STREAM),
  ...each(
    "Stream",
    ["fromEventListener"],
    "listens to an EventTarget, which is outside the handler",
  ),
  ...each(
    "Channel",
    [
      "hasUpstreamFailure",
      "restoreUpstreamFailure",
      "unwrapUpstreamFailure",
      "upstreamFailureToDefect",
    ],
    INTERNAL,
  ),
  ...each("Context", ["getOrUndefinedUnsafe", "hasSameCache"], INTERNAL),
  ...each("Hash", ["random"], "gives each object a random hash: no two runs give the same"),
  ...each(
    "Hash",
    ["symbol"],
    "names a class's own hash method, which the prover does not call: it hashes an instance by its fields",
  ),
  ...each(
    "Layer",
    [
      "CurrentMemoMap",
      "buildWithMemoMap",
      "forkMemoMap",
      "forkMemoMapUnsafe",
      "makeMemoMap",
      "makeMemoMapUnsafe",
      "fromBuild",
      "fromBuildMemo",
    ],
    MEMO_MAP,
  ),
  ...each("Layer", ["launch"], "builds a layer and never ends: the handler would never end"),
  ...each(
    "Metric",
    [
      "CurrentMetricAttributes",
      "CurrentMetricAttributesKey",
      "FiberRuntimeMetrics",
      "FiberRuntimeMetricsImpl",
      "FiberRuntimeMetricsKey",
      "MetricRegistry",
      "disableRuntimeMetrics",
      "disableRuntimeMetricsLayer",
      "dump",
      "enableRuntimeMetrics",
      "enableRuntimeMetricsLayer",
      "registerUnsafe",
      "remove",
      "removeUnsafe",
      "snapshot",
      "snapshotUnsafe",
    ],
    METRICS,
  ),
  ...each(
    "Request",
    ["RequestPrototype"],
    "is the prototype the library builds a request on: Request.tagged, Request.of and Request.Class make one",
  ),
]);

/**
 * Names the prover reads another way than by a model of its own: where the
 * code declares a service, an enum, or a schema.
 */
export const ELSEWHERE: ReadonlyMap<string, string> = new Map([
  ["effect/Context:Service", "the class it makes is read where a file declares a service"],
  ["effect/Context:Reference", "the service it makes is read where a file declares one"],
  ["effect/Data:taggedEnum", "the enum it makes is read where a file declares one"],
]);

/** What the prover says when the code calls one of these: why it is reported. */
export const reasonOf = (module: string, path: ReadonlyArray<string>): string | undefined =>
  path.length === 1 ? JUDGED.get(`${module}:${path[0]}`) : undefined;
