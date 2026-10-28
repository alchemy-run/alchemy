/**
 * The private wire format a workflow step uses to carry a typed Effect
 * failure through the engine's native step retry/storage machinery, which
 * keeps only an `Error`'s message. Shared by every Workflows engine that
 * follows the Cloudflare Workflows API (Cloudflare, Celld).
 *
 * @internal
 */
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Base64, Base64Url } from "effect/encoding";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { encodeRpcError } from "../Rpc.ts";

/** The raw value a native `step.do` rejected with, decoded back into a Cause below. */
class NativeStepRejection extends Data.TaggedError("NativeStepRejection")<{
  readonly error: unknown;
}> {}

/** The workflow run a step failure belongs to. */
export interface WorkflowIdentity {
  readonly workflow: string;
  readonly instanceId: string;
}

/** Build the engine's non-retryable error for a terminal failure message. */
export type TerminalFailure = (message: string) => Promise<Error>;

const failurePrefix = "[alchemy-workflow-failure:v1]";
const terminalPrefix = "[alchemy-workflow-terminal:v1]";
const maxFailureLength = 16_384;

/** The marked message of a terminal (non-retryable) step failure. */
export const terminalFailureMessage = (message: string): string => `${terminalPrefix}${message}`;

/**
 * Encode a step's failure cause into the engine's native error (and decode
 * it back on the run side), terminating with `terminalFailure` for defects,
 * interruptions and unserializable failures.
 */
export const makeWorkflowFailureCodec = (terminalFailure: TerminalFailure) => {
  const callbackFailure = async <E>(
    cause: Cause.Cause<E>,
    step: string,
    identity: WorkflowIdentity | undefined,
  ): Promise<Error> => {
    if (!Cause.hasDies(cause) && !Cause.hasInterrupts(cause)) {
      try {
        const budget = { nodes: 0, seen: new Set<object>() };
        const errors = cause.reasons.map((reason) => {
          if (reason._tag !== "Fail") throw new TypeError("Expected an application failure");
          return encodeFailureValue(reason.error, new Set<object>(), budget);
        });
        const error = Cause.squash(cause);
        const summary =
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Workflow application failure";
        const body = `${Base64Url.encode(
          JSON.stringify({
            workflow: identity?.workflow ?? null,
            instanceId: identity?.instanceId ?? null,
            step,
            errors,
          }),
        )}\n${summary}`;
        const message = `${failurePrefix}${await failureDigest(body)}:${body}`;
        if (new TextEncoder().encode(message).byteLength > maxFailureLength)
          throw new TypeError("encoded failure exceeds 16 KiB");
        return new Error(message);
      } catch (error) {
        throw await terminalFailure(
          `Workflow application failure is not serializable: ${error instanceof Error ? error.message : "unsupported value"}`,
        );
      }
    }
    const error = Cause.squash(cause);
    return terminalFailure(
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Workflow callback defect or interruption",
    );
  };

  const decodeApplicationFailure = async <E>(
    error: unknown,
    step: string,
    identity: WorkflowIdentity | undefined,
  ): Promise<Cause.Cause<E> | undefined> => {
    if (
      !identity?.workflow ||
      !identity.instanceId ||
      !(error instanceof Error) ||
      error.name !== "Error" ||
      !error.message.startsWith(failurePrefix)
    )
      return undefined;
    try {
      if (new TextEncoder().encode(error.message).byteLength > maxFailureLength)
        throw new TypeError("encoded failure exceeds 16 KiB");
      const encoded = error.message.slice(failurePrefix.length);
      const separator = encoded.indexOf(":");
      const digest = encoded.slice(0, separator);
      const body = encoded.slice(separator + 1);
      if (separator !== 43 || digest !== (await failureDigest(body)))
        throw new TypeError("invalid failure checksum");
      const end = body.indexOf("\n");
      if (end < 1) throw new TypeError("invalid failure framing");
      const json = Base64Url.decodeString(body.slice(0, end));
      if (Result.isFailure(json)) throw new TypeError("invalid failure encoding");
      const envelope: unknown = JSON.parse(json.success);
      if (
        !envelope ||
        typeof envelope !== "object" ||
        !("workflow" in envelope) ||
        envelope.workflow !== identity.workflow ||
        !("instanceId" in envelope) ||
        envelope.instanceId !== identity.instanceId ||
        !("step" in envelope) ||
        envelope.step !== step ||
        !("errors" in envelope) ||
        !Array.isArray(envelope.errors) ||
        envelope.errors.length === 0 ||
        Object.keys(envelope).length !== 4
      )
        throw new TypeError("invalid failure envelope");
      // Only the validated private transport restores E's data; prototypes and identity are invocation-local.
      const errors = envelope.errors.map((value) => decodeFailureValue(value)) as E[];
      return Cause.fromReasons(errors.map((value) => Cause.makeFailReason(value)));
    } catch (cause) {
      throw new TypeError("Invalid persisted Workflow application failure", { cause });
    }
  };

  return { callbackFailure, decodeApplicationFailure };
};

const failureDigest = async (body: string): Promise<string> =>
  Base64Url.encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))),
  );

type FailureValue = null | boolean | string | number | FailureValue[];

const encodeFailureValue = (
  value: unknown,
  ancestors = new Set<object>(),
  budget = { nodes: 0, seen: new Set<object>() },
): FailureValue => {
  if (
    ++budget.nodes > maxFailureLength ||
    (typeof value === "string" && value.length > maxFailureLength)
  )
    throw new TypeError("encoded failure exceeds 16 KiB");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number")
    return Number.isFinite(value) && !Object.is(value, -0)
      ? value
      : ["number", Object.is(value, -0) ? "-0" : String(value)];
  if (value === undefined) return ["undefined"];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (typeof value !== "object") throw new TypeError(`unsupported ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("cyclic error data");
  if (budget.seen.has(value)) throw new TypeError("shared references in error data");
  budget.seen.add(value);
  if (ancestors.size >= 64) throw new TypeError("error data exceeds 64 nesting levels");
  ancestors.add(value);
  try {
    const encode = (item: unknown) => encodeFailureValue(item, ancestors, budget);
    const symbols = Object.getOwnPropertySymbols(value).filter(
      (key) => !(value instanceof Error && key === Symbol.for("effect/Data/Error/plainArgs")),
    );
    if (symbols.length) throw new TypeError("symbol-keyed error data");
    if (
      value instanceof Date ||
      value instanceof Uint8Array ||
      value instanceof ArrayBuffer ||
      value instanceof Map ||
      value instanceof Set
    ) {
      const own = Object.getOwnPropertyNames(value);
      if (own.some((key) => !(value instanceof Uint8Array && /^(0|[1-9]\d*)$/.test(key))))
        throw new TypeError("custom properties on serialized built-in values");
      if (value instanceof Date) return ["date", encode(Date.prototype.getTime.call(value))];
      if (value instanceof Uint8Array) return ["bytes", Base64.encode(value)];
      if (value instanceof ArrayBuffer) return ["buffer", Base64.encode(new Uint8Array(value))];
      if (value instanceof Map)
        return [
          "map",
          [...Map.prototype.entries.call(value)].map(([key, item]) => [encode(key), encode(item)]),
        ];
      return ["set", [...Set.prototype.values.call(value)].map(encode)];
    }
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors);
      if (
        keys.length !== value.length + 1 ||
        keys.some(
          (key) => key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length),
        )
      )
        throw new TypeError("sparse arrays or custom array properties");
      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor)) throw new TypeError("accessor error data");
      }
      return [
        "array",
        Array.from({ length: value.length }, (_, i) => encode(descriptors[i].value)),
      ];
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    let tag: string | undefined;
    for (let owner: object | null = value; owner; owner = Object.getPrototypeOf(owner)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, "_tag");
      if (!descriptor) continue;
      if (!("value" in descriptor)) throw new TypeError("accessor error data");
      if (typeof descriptor.value === "string") tag = descriptor.value;
      break;
    }
    const prototype = Object.getPrototypeOf(value);
    if (
      !(value instanceof Error) &&
      prototype !== null &&
      prototype !== Object.prototype &&
      tag === undefined
    )
      throw new TypeError("unsupported class instance");
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor) && !(value instanceof Error && key === "stack"))
        throw new TypeError("accessor error data");
    }
    const fields = new Map<string, unknown>();
    if (tag !== undefined) fields.set("_tag", tag);
    if (value instanceof Error) {
      for (const key of ["name", "message", "stack"]) {
        let owner: object | null = value;
        while (owner) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, key);
          if (descriptor) {
            if (!("value" in descriptor) && !(owner === value && key === "stack"))
              throw new TypeError("accessor error data");
            break;
          }
          owner = Object.getPrototypeOf(owner);
        }
      }
      for (const [key, item] of Object.entries(encodeRpcError(value) as Record<string, unknown>))
        fields.set(key, item);
      fields.set("name", value.name);
      fields.set("message", value.message);
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!("value" in descriptor)) {
        if (value instanceof Error && key === "stack") fields.set(key, value.stack);
        else throw new TypeError("accessor error data");
      } else fields.set(key, descriptor.value);
    }
    return [
      value instanceof Error ? "error" : "object",
      [...fields].map(([key, item]) => [key, encode(item)]),
    ];
  } finally {
    ancestors.delete(value);
  }
};

const decodeFailureValue = (value: unknown, depth = 0): unknown => {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (!Array.isArray(value)) throw new TypeError("invalid serialized error value");
  const decode = (item: unknown) => decodeFailureValue(item, depth + 1);
  const [tag, data] = value;
  if (tag === "undefined" && value.length === 1) return undefined;
  if (value.length !== 2) throw new TypeError("invalid serialized error tuple");
  if (
    tag === "number" &&
    typeof data === "string" &&
    ["NaN", "Infinity", "-Infinity", "-0"].includes(data)
  )
    return Number(data);
  if (tag === "bigint" && typeof data === "string" && /^-?(0|[1-9]\d*)$/.test(data))
    return BigInt(data);
  if (depth >= 64) throw new TypeError("invalid serialized error value");
  if (tag === "date") {
    const timestamp = decode(data);
    if (typeof timestamp === "number") return new Date(timestamp);
  }
  if ((tag === "bytes" || tag === "buffer") && typeof data === "string") {
    const bytes = Base64.decode(data);
    if (Result.isSuccess(bytes) && Base64.encode(bytes.success) === data)
      return tag === "bytes" ? bytes.success : bytes.success.buffer;
  }
  if (Array.isArray(data)) {
    if (tag === "array") return data.map(decode);
    if (tag === "set") return new Set(data.map(decode));
    if (tag === "map")
      return new Map(
        data.map((pair) => {
          if (!Array.isArray(pair) || pair.length !== 2)
            throw new TypeError("invalid serialized map");
          return [decode(pair[0]), decode(pair[1])];
        }),
      );
    if (tag === "object" || tag === "error") {
      const result = tag === "error" ? new Error() : {};
      const keys = new Set<string>();
      for (const pair of data) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          typeof pair[0] !== "string" ||
          keys.has(pair[0])
        )
          throw new TypeError("invalid serialized error fields");
        keys.add(pair[0]);
        Object.defineProperty(result, pair[0], {
          value: decode(pair[1]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
  }
  throw new TypeError("invalid serialized error value");
};

/**
 * Run one durable workflow task through the engine's native step API,
 * owning its native callbacks: a typed failure crosses the native step as
 * an encoded error and is decoded back into the task's failure channel;
 * interruption does not wait out native retry timers.
 */
export const runWorkflowTask = <A, E, C>(options: {
  readonly name: string;
  readonly identity?: WorkflowIdentity;
  readonly terminalFailure: TerminalFailure;
  /** The engine's own terminal errors, rethrown as-is. */
  readonly isNativeTerminal?: (error: unknown) => error is Error;
  readonly effect: (context: C) => Effect.Effect<A, E, Scope.Scope>;
  readonly native: (
    callback: (context: C) => Promise<A>,
    run: <B, F>(effect: Effect.Effect<B, F, Scope.Scope>) => Promise<B>,
  ) => Promise<A>;
}): Effect.Effect<A, E> => {
  const { callbackFailure, decodeApplicationFailure } = makeWorkflowFailureCodec(
    options.terminalFailure,
  );
  const encode = async <F>(cause: Cause.Cause<F>) => {
    const original = Cause.squash(cause);
    return options.isNativeTerminal?.(original)
      ? original
      : await callbackFailure(cause, options.name, options.identity);
  };
  return Effect.scoped(
    Effect.gen(function* () {
      const runPromise = yield* FiberSet.makeRuntimePromise<never>();
      let failure: { message: string; cause: Cause.Cause<E> } | undefined;
      const run = async <B, F>(effect: Effect.Effect<B, F, Scope.Scope>) => {
        const exit = await runPromise(
          Effect.yieldNow.pipe(Effect.andThen(effect), Effect.scoped, Effect.exit),
        );
        if (Exit.isSuccess(exit)) return exit.value;
        throw await encode(exit.cause);
      };
      const callback = async (context: C) => {
        // Register the fiber before callback effects can interrupt their owner.
        const exit = await runPromise(
          Effect.yieldNow.pipe(
            Effect.andThen(Effect.suspend(() => options.effect(context))),
            Effect.scoped,
            Effect.exit,
          ),
        );
        if (Exit.isSuccess(exit)) return exit.value;
        const error = await encode(exit.cause);
        // Native persistence discards custom fields; only match this invocation's error.
        if (!Cause.hasDies(exit.cause) && !Cause.hasInterrupts(exit.cause)) {
          failure = { message: error.message, cause: exit.cause };
        }
        throw error;
      };
      return yield* Effect.tryPromise({
        try: () => options.native(callback, run),
        catch: (error) => new NativeStepRejection({ error }),
      }).pipe(
        Effect.catch(({ error }) =>
          failure &&
          error instanceof Error &&
          error.name === "Error" &&
          error.message === failure.message
            ? Effect.failCause(failure.cause)
            : Effect.promise(() =>
                decodeApplicationFailure<E>(error, options.name, options.identity),
              ).pipe(
                Effect.flatMap((cause) => (cause ? Effect.failCause(cause) : Effect.die(error))),
              ),
        ),
      );
    }),
  );
};

/** Close run resources with the original exit; cleanup cannot replace the result. */
export const withWorkflowScope = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  isEjected: (scope: Scope.Scope) => boolean = () => false,
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const exit = yield* restore(effect.pipe(Effect.provideService(Scope.Scope, scope))).pipe(
        Effect.exit,
      );
      if (!isEjected(scope)) {
        yield* Scope.close(scope, exit).pipe(
          Effect.ignoreCause({ log: "Warn", message: "Workflow run scope close failed" }),
        );
      }
      return yield* exit;
    }),
  );
