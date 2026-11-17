import {
  serializeClassParameters,
  type ClassParameterValue,
} from "@distilled.cloud/modal/ClassParameters";
import * as functions from "@distilled.cloud/modal/functions";
import type { Input } from "alchemy/Input";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { environmentOf, type ErrorOf, type OpError, operations } from "./internal.ts";
import type { OperationServices } from "./internal.ts";
import type { FunctionRef, FunctionTarget } from "./InvokeFunction.ts";
import * as ModalBindings from "./ModalBindings.ts";

/*
 * Shared scaffolding for bindings on a function (a `Modal.Function` or
 * `Modal.Server` of the Stack, or a deployed function by name). NOT exported
 * from `index.ts`.
 */

export const isFunctionRef = (target: unknown): target is FunctionRef =>
  typeof target === "object" &&
  target !== null &&
  typeof (target as FunctionRef).app === "string" &&
  typeof (target as FunctionRef).function === "string";

/** A resolved target: its function id (looked up once) and the class method, if any. */
export interface ResolvedFunction {
  readonly functionId: Effect.Effect<string, FunctionLookupError>;
  readonly method: string | undefined;
}

/** A parameter value missing from a parameterized class call. */
export class FunctionParameterMissing extends Data.TaggedError("Modal.FunctionParameterMissing")<{
  readonly message: string;
}> {}

const PARAM_TYPE = {
  string: "PARAM_TYPE_STRING",
  number: "PARAM_TYPE_INT",
  boolean: "PARAM_TYPE_BOOL",
  bytes: "PARAM_TYPE_BYTES",
} as const;

/**
 * Serialize class parameters as Modal's `ClassParameterSet`, in the class's
 * schema order with its defaults applied, as Modal's clients do: the bytes
 * identify the bound function.
 */
const serializeParameters = Effect.fn(function* (
  schema: ReadonlyArray<functions.ClassParameterSpec>,
  values: Record<string, string | number | boolean | Uint8Array>,
) {
  const parameters: Array<ClassParameterValue> = [];
  for (const spec of schema) {
    const name = spec.name ?? "";
    const value = values[name];
    if (value === undefined) {
      if (!spec.hasDefault) {
        return yield* new FunctionParameterMissing({ message: `Missing class parameter ${name}` });
      }
      parameters.push({
        name,
        type: spec.type ?? "PARAM_TYPE_UNSPECIFIED",
        stringValue: spec.stringDefault,
        intValue: spec.intDefault,
        bytesValue: spec.bytesDefault,
        boolValue: spec.boolDefault,
      });
      continue;
    }
    parameters.push(
      typeof value === "string"
        ? { name, type: PARAM_TYPE.string, stringValue: value }
        : typeof value === "number"
          ? { name, type: PARAM_TYPE.number, intValue: String(Math.trunc(value)) }
          : typeof value === "boolean"
            ? { name, type: PARAM_TYPE.boolean, boolValue: value }
            : {
                name,
                type: PARAM_TYPE.bytes,
                bytesValue: Buffer.from(value).toString("base64"),
              },
    );
  }
  return yield* Effect.sync(() => serializeClassParameters(parameters));
});

/**
 * Resolve a target in the construction phase. A resource of the Stack
 * carries its id; a name is looked up on first use and cached (the id only
 * changes when the App is redeployed).
 */
/** The operations that look a function up by name, resolved by `ModalBindings.withCredentials`. */
export const FunctionLookupOps = operations({
  get: functions.getFunction,
  bindParams: functions.functionBindParams,
});

export type FunctionLookupOps = Effect.Success<typeof FunctionLookupOps>;

/** Looking a function up by name (and binding a class's parameters). */
export type FunctionLookupError =
  | OpError<FunctionLookupOps, "get" | "bindParams">
  | ErrorOf<typeof serializeParameters>;

export const resolveFunction = Effect.fn(function* (
  lookup: FunctionLookupOps,
  target: FunctionTarget | { readonly functionId: unknown },
) {
  if (!isFunctionRef(target)) {
    const functionId = yield* (
      target as { readonly functionId: Effect.Effect<Effect.Effect<string>> }
    ).functionId;
    return { functionId, method: undefined } satisfies ResolvedFunction;
  }
  const [tag, method] = target.function.includes(".")
    ? [`${target.function.split(".")[0]}.*`, target.function.split(".").slice(1).join(".")]
    : [target.function, undefined];
  let cached: string | undefined;
  const functionId = Effect.suspend(() =>
    cached !== undefined
      ? Effect.succeed(cached)
      : Effect.gen(function* () {
          const environmentName = environmentOf(target.environment);
          const found = yield* lookup.get({
            appName: target.app,
            objectTag: tag,
            environmentName,
          });
          let id = found.functionId ?? "";
          // A parameterized class runs a bound function per parameter set.
          if (target.parameters !== undefined) {
            const schema = found.handleMetadata?.classParameterInfo?.schema ?? [];
            const serializedParams = yield* serializeParameters(schema, target.parameters);
            const bound = yield* lookup.bindParams({
              functionId: id,
              serializedParams,
              environmentName,
            });
            id = bound.boundFunctionId ?? id;
          }
          cached = id;
          return id;
        }),
  );
  return { functionId, method } satisfies ResolvedFunction;
});

/**
 * A binding layer over a function target: grants the host's identity `role`
 * on the function's environment (deploy only), resolves the target, and
 * builds the client over `operations`.
 */
export const makeFunctionBinding = <Target, Ops, Client>(options: {
  readonly tag: string;
  readonly operations: Effect.Effect<Ops, never, OperationServices>;
  readonly role: ModalBindings.EnvironmentGrant["role"];
  readonly make: (resolved: ResolvedFunction, ops: Ops, target: Target) => Effect.Effect<Client>;
}) =>
  Effect.gen(function* () {
    const lookup = yield* ModalBindings.withCredentials(FunctionLookupOps);
    const ops = yield* ModalBindings.withCredentials(options.operations);
    const bind = yield* ModalBindings.Bind;
    return Effect.fn(options.tag)(function* (target: Target) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        if (isFunctionRef(target)) {
          yield* bind`${options.tag}`({
            roles: [{ environment: target.environment, role: options.role }],
          });
        } else {
          const environment = (target as { readonly environment: Input<string | undefined> })
            .environment;
          yield* bind`${options.tag}(${target})`({
            roles: [{ environment, role: options.role }],
          });
        }
      }
      const resolved = yield* resolveFunction(lookup, target as FunctionTarget);
      return yield* options.make(resolved, ops, target);
    });
  });
