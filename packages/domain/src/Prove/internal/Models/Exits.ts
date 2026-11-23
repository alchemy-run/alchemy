import * as Effect from "effect/Effect";
import type { Kit, Model, Models } from "../Kit.ts";
import { arr, dual, lazy, onEffect, tagOf, wrongArguments } from "../Kit.ts";
import type { Eval, Site, V } from "../Value.ts";
import * as Value from "../Value.ts";

const success = (value: V): V => Value.obj({ _tag: Value.str("Success"), value });
const failed = (error: V): V => Value.obj({ _tag: Value.str("Fail"), error });
const died = (defect: V): V => Value.obj({ _tag: Value.str("Die"), defect });
const causeOf = (reason: V): V => Value.obj({ reasons: arr([reason]) });
const failure = (reason: V): V => Value.obj({ _tag: Value.str("Failure"), cause: causeOf(reason) });

/**
 * `Exit` and `Cause`: how an effect ended, as data. An exit is a success
 * with its value, or a failure with its cause; a cause here has one reason,
 * a failure the code can handle or a defect.
 */
export const make = (kit: Kit) => {
  const { host } = kit;

  /** The reasons of a cause the prover sees into. */
  const reasonsOf = (cause: V | undefined): ReadonlyArray<V> | undefined =>
    cause?._tag === "Obj" ? kit.itemsOf(cause.fields.reasons) : undefined;

  /** The cause of an exit that failed: `undefined` for one that succeeded. */
  const exitOf = (
    name: string,
    exit: V | undefined,
    site: Site,
  ): Eval<{ readonly value: V } | { readonly cause: V }> => {
    const tag = tagOf(exit);
    if (exit?._tag === "Obj" && tag === "Success")
      return Effect.succeed({ value: exit.fields.value ?? Value.undef });
    if (exit?._tag === "Obj" && tag === "Failure" && exit.fields.cause)
      return Effect.succeed({ cause: exit.fields.cause });
    return wrongArguments(site, name);
  };

  const onExit = (
    name: string,
    arity: number,
    body: (
      exit: { readonly value: V } | { readonly cause: V },
      rest: ReadonlyArray<V>,
      site: Site,
      self: V,
    ) => Eval<V>,
  ): Model =>
    dual(name, arity, ([self, ...rest], site) =>
      Effect.flatMap(exitOf(name, self, site), (exit) => body(exit, rest, site, self!)),
    );

  const found = (cause: V | undefined, tag: "Fail" | "Die"): V | undefined =>
    reasonsOf(cause)?.find((reason) => tagOf(reason) === tag);

  const errorOf = (cause: V | undefined): V => {
    const reason = found(cause, "Fail");
    return reason?._tag === "Obj" && reason.fields.error
      ? Value.some(reason.fields.error)
      : Value.none;
  };

  const has =
    (name: string, tag: "Fail" | "Die"): Model =>
    ([cause], site) =>
      reasonsOf(cause)
        ? Effect.succeed(Value.bool(found(cause, tag) !== undefined))
        : wrongArguments(site, name);

  const handlerOf = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;

  const models: Models = {
    // How the effect ended, as a value: a defect too, which nothing else here handles.
    "effect/Effect:exit": onEffect("Effect.exit", 0, (self) =>
      Effect.map(self, success).pipe(
        Effect.catchTag("Rejected", (rejected) =>
          // What stops a saga until a signal comes is not an end of the effect.
          rejected.rejection._tag === "Opaque"
            ? Effect.fail(rejected)
            : Effect.succeed(
                failure(
                  rejected.defect === true ? died(rejected.rejection) : failed(rejected.rejection),
                ),
              ),
        ),
      ),
    ),
    "effect/Effect:failCause": ([cause], site) => {
      const reason = found(cause, "Fail") ?? found(cause, "Die");
      if (reason?._tag !== "Obj") return wrongArguments(site, "Effect.failCause");
      const defect = tagOf(reason) === "Die";
      const rejection = (defect ? reason.fields.defect : reason.fields.error) ?? Value.undef;
      return Effect.succeed(
        lazy(() => Effect.fail(new Value.Rejected(defect ? { rejection, defect } : { rejection }))),
      );
    },
    "effect/Exit:succeed": ([value]) => Effect.succeed(success(value ?? Value.undef)),
    "effect/Exit:fail": ([error]) => Effect.succeed(failure(failed(error ?? Value.undef))),
    "effect/Exit:die": ([defect]) => Effect.succeed(failure(died(defect ?? Value.undef))),
    "effect/Exit:isSuccess": onExit("Exit.isSuccess", 1, (exit) =>
      Effect.succeed(Value.bool("value" in exit)),
    ),
    "effect/Exit:isFailure": onExit("Exit.isFailure", 1, (exit) =>
      Effect.succeed(Value.bool("cause" in exit)),
    ),
    "effect/Exit:match": onExit("Exit.match", 2, (exit, [cases], site) => {
      const handler = handlerOf(cases, "value" in exit ? "onSuccess" : "onFailure");
      return handler
        ? host.call(handler, ["value" in exit ? exit.value : exit.cause], site)
        : wrongArguments(site, "Exit.match");
    }),
    "effect/Exit:map": onExit("Exit.map", 2, (exit, [f], site, self) =>
      "cause" in exit
        ? Effect.succeed(self)
        : f
          ? Effect.map(host.call(f, [exit.value], site), success)
          : wrongArguments(site, "Exit.map"),
    ),
    "effect/Exit:mapError": onExit("Exit.mapError", 2, (exit, [f], site, self) => {
      const reason = "cause" in exit ? found(exit.cause, "Fail") : undefined;
      if (reason?._tag !== "Obj") return Effect.succeed(self);
      return f
        ? Effect.map(host.call(f, [reason.fields.error ?? Value.undef], site), (error) =>
            failure(failed(error)),
          )
        : wrongArguments(site, "Exit.mapError");
    }),
    "effect/Exit:asVoid": onExit("Exit.asVoid", 1, (exit, _, __, self) =>
      Effect.succeed("value" in exit ? success(Value.undef) : self),
    ),
    "effect/Exit:getSuccess": onExit("Exit.getSuccess", 1, (exit) =>
      Effect.succeed("value" in exit ? Value.some(exit.value) : Value.none),
    ),
    "effect/Exit:getCause": onExit("Exit.getCause", 1, (exit) =>
      Effect.succeed("cause" in exit ? Value.some(exit.cause) : Value.none),
    ),
    "effect/Exit:findErrorOption": onExit("Exit.findErrorOption", 1, (exit) =>
      Effect.succeed("cause" in exit ? errorOf(exit.cause) : Value.none),
    ),
    "effect/Exit:hasFails": onExit("Exit.hasFails", 1, (exit) =>
      Effect.succeed(Value.bool("cause" in exit && found(exit.cause, "Fail") !== undefined)),
    ),
    "effect/Exit:hasDies": onExit("Exit.hasDies", 1, (exit) =>
      Effect.succeed(Value.bool("cause" in exit && found(exit.cause, "Die") !== undefined)),
    ),
    "effect/Cause:fail": ([error]) => Effect.succeed(causeOf(failed(error ?? Value.undef))),
    "effect/Cause:die": ([defect]) => Effect.succeed(causeOf(died(defect ?? Value.undef))),
    "effect/Cause:hasFails": has("Cause.hasFails", "Fail"),
    "effect/Cause:hasDies": has("Cause.hasDies", "Die"),
    "effect/Cause:findErrorOption": ([cause], site) =>
      reasonsOf(cause)
        ? Effect.succeed(errorOf(cause))
        : wrongArguments(site, "Cause.findErrorOption"),
    // The error a cause failed with, or else what it died of.
    "effect/Cause:squash": ([cause], site) => {
      const reason = found(cause, "Fail") ?? found(cause, "Die");
      return reason?._tag === "Obj"
        ? Effect.succeed(reason.fields.error ?? reason.fields.defect ?? Value.undef)
        : wrongArguments(site, "Cause.squash");
    },
  };

  return { models };
};
