import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Brands from "../Brands.ts";
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

  const found = (cause: V | undefined, tag: "Fail" | "Die" | "Interrupt"): V | undefined =>
    reasonsOf(cause)?.find((reason) => tagOf(reason) === tag);

  const errorOf = (cause: V | undefined): V => {
    const reason = found(cause, "Fail");
    return reason?._tag === "Obj" && reason.fields.error
      ? Value.some(reason.fields.error)
      : Value.none;
  };

  const has =
    (name: string, tag: "Fail" | "Die" | "Interrupt"): Model =>
    ([cause], site) =>
      reasonsOf(cause)
        ? Effect.succeed(Value.bool(found(cause, tag) !== undefined))
        : wrongArguments(site, name);

  const handlerOf = (cases: V | undefined, key: string): V | undefined =>
    cases?._tag === "Obj" ? cases.fields[key] : undefined;

  /** The first reason of a kind a cause holds, as a `Result`: what it holds, or the cause where it holds none. */
  const finding =
    (
      name: string,
      tag: "Fail" | "Die" | "Interrupt",
      gives: (reason: V & { readonly _tag: "Obj" }) => V | undefined,
    ): Model =>
    ([cause], site) => {
      if (!cause || !reasonsOf(cause)) return wrongArguments(site, name);
      const reason = found(cause, tag);
      return Effect.succeed(
        reason?._tag === "Obj"
          ? Brands.success(gives(reason) ?? Value.undef)
          : Brands.failure(cause),
      );
    };

  const said = (message: V | undefined): Record<string, V> =>
    message && message._tag !== "Undef" ? { message } : {};
  const models: Models = {
    // The errors the library makes, made by the code: `new Cause.TimeoutError("too slow")`.
    ...Object.fromEntries(
      ["NoSuchElementError", "TimeoutError", "IllegalArgumentError", "ExceededCapacityError"].map(
        (tag): [string, Model] => [
          `effect/Cause:${tag}`,
          ([message]) => Effect.succeed(Value.libraryError(tag, said(message))),
        ],
      ),
    ),
    "effect/Cause:UnknownError": ([cause, message]) =>
      Effect.succeed(
        Value.libraryError("UnknownError", { cause: cause ?? Value.undef, ...said(message) }),
      ),
    // How the effect ended, as a value: a defect too, which nothing else here handles.
    "effect/Effect:exit": onEffect("Effect.exit", 0, (self) =>
      Effect.map(self, success).pipe(
        // An effect stopped from inside, by a fiber or a Deferred that was interrupted.
        Effect.catchCauseIf(Cause.hasInterruptsOnly, () =>
          Effect.succeed(failure(Value.obj({ _tag: Value.str("Interrupt") }))),
        ),
        // An interrupt beside a failure: the exit holds every reason, in order.
        Effect.catchCauseIf(
          (cause) =>
            cause.reasons.some(Cause.isInterruptReason) &&
            cause.reasons.every(
              (reason) =>
                Cause.isInterruptReason(reason) ||
                (Cause.isFailReason(reason) &&
                  reason.error instanceof Value.Rejected &&
                  reason.error.rejection._tag !== "Opaque"),
            ),
          (cause) =>
            Effect.succeed(
              Value.obj({
                _tag: Value.str("Failure"),
                cause: Value.obj({
                  reasons: arr(
                    cause.reasons.map((reason) => {
                      if (!Cause.isFailReason(reason) || !(reason.error instanceof Value.Rejected))
                        return Value.obj({ _tag: Value.str("Interrupt") });
                      const rejected = reason.error;
                      return rejected.defect === true
                        ? died(rejected.rejection)
                        : failed(rejected.rejection);
                    }),
                  ),
                }),
              }),
            ),
        ),
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
    "effect/Exit:hasInterrupts": onExit("Exit.hasInterrupts", 1, (exit) =>
      Effect.succeed(Value.bool("cause" in exit && found(exit.cause, "Interrupt") !== undefined)),
    ),
    "effect/Cause:hasInterrupts": has("Cause.hasInterrupts", "Interrupt"),
    "effect/Cause:hasInterruptsOnly": ([cause], site) => {
      const reasons = reasonsOf(cause);
      return reasons
        ? Effect.succeed(
            Value.bool(
              reasons.length > 0 && reasons.every((reason) => tagOf(reason) === "Interrupt"),
            ),
          )
        : wrongArguments(site, "Cause.hasInterruptsOnly");
    },
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
    // ---- A cause as data: its reasons, found, made and put together.
    "effect/Cause:isCause": ([value]) => Effect.succeed(Value.bool(reasonsOf(value) !== undefined)),
    "effect/Cause:isReason": ([value]) =>
      Effect.succeed(Value.bool(["Fail", "Die", "Interrupt"].includes(tagOf(value) ?? ""))),
    "effect/Cause:isFailReason": ([value]) => Effect.succeed(Value.bool(tagOf(value) === "Fail")),
    "effect/Cause:isDieReason": ([value]) => Effect.succeed(Value.bool(tagOf(value) === "Die")),
    "effect/Cause:isInterruptReason": ([value]) =>
      Effect.succeed(Value.bool(tagOf(value) === "Interrupt")),
    "effect/Cause:makeFailReason": ([error]) => Effect.succeed(failed(error ?? Value.undef)),
    "effect/Cause:makeDieReason": ([defect]) => Effect.succeed(died(defect ?? Value.undef)),
    "effect/Cause:makeInterruptReason": () =>
      Effect.succeed(Value.obj({ _tag: Value.str("Interrupt") })),
    "effect/Cause:fromReasons": ([reasons], site) => {
      const items = kit.itemsOf(reasons);
      return items
        ? Effect.succeed(Value.obj({ reasons: arr(items) }))
        : wrongArguments(site, "Cause.fromReasons");
    },
    "effect/Cause:combine": dual("Cause.combine", 2, ([self, that], site) => {
      const [left, right] = [reasonsOf(self), reasonsOf(that)];
      return left && right
        ? Effect.succeed(Value.obj({ reasons: arr([...left, ...right]) }))
        : wrongArguments(site, "Cause.combine");
    }),
    // Each error the cause failed with, as the function gives it.
    "effect/Cause:map": dual("Cause.map", 2, ([self, f], site) => {
      const reasons = reasonsOf(self);
      if (!reasons || !f) return wrongArguments(site, "Cause.map");
      return Effect.map(
        Effect.forEach(reasons, (reason) =>
          reason._tag === "Obj" && tagOf(reason) === "Fail"
            ? Effect.map(host.call(f, [reason.fields.error ?? Value.undef], site), failed)
            : Effect.succeed(reason),
        ),
        (mapped) => Value.obj({ reasons: arr(mapped) }),
      );
    }),
    // What a cause holds, or the cause itself where it holds none.
    "effect/Cause:findError": finding("Cause.findError", "Fail", (reason) => reason.fields.error),
    "effect/Cause:findFail": finding("Cause.findFail", "Fail", (reason) => reason),
    "effect/Cause:findDefect": finding("Cause.findDefect", "Die", (reason) => reason.fields.defect),
    "effect/Cause:findDie": finding("Cause.findDie", "Die", (reason) => reason),
    "effect/Cause:findInterrupt": finding("Cause.findInterrupt", "Interrupt", (reason) => reason),
    ...Object.fromEntries(
      [
        "NoSuchElement",
        "Timeout",
        "Unknown",
        "IllegalArgument",
        "ExceededCapacity",
        "AsyncFiber",
      ].map((name): [string, Model] => [
        `effect/Cause:is${name}Error`,
        // One the library made: it carries the library's own mark, not only the tag.
        ([value]) =>
          Effect.succeed(
            Value.bool(
              value?._tag === "Obj" && value.fields[`~effect/Cause/${name}Error`] !== undefined,
            ),
          ),
      ]),
    ),
    // ---- An exit as data.
    "effect/Exit:isExit": ([value]) =>
      Effect.succeed(Value.bool(["Success", "Failure"].includes(tagOf(value) ?? ""))),
    "effect/Exit:mapBoth": onExit("Exit.mapBoth", 2, (exit, [cases], site, self) => {
      const [onFailure, onSuccess] = [handlerOf(cases, "onFailure"), handlerOf(cases, "onSuccess")];
      if (!onFailure || !onSuccess) return wrongArguments(site, "Exit.mapBoth");
      if ("value" in exit) return Effect.map(host.call(onSuccess, [exit.value], site), success);
      const reason = found(exit.cause, "Fail");
      return reason?._tag === "Obj"
        ? Effect.map(host.call(onFailure, [reason.fields.error ?? Value.undef], site), (error) =>
            failure(failed(error)),
          )
        : Effect.succeed(self);
    }),
    "effect/Exit:filterSuccess": onExit("Exit.filterSuccess", 1, (exit, _, __, self) =>
      Effect.succeed("value" in exit ? Brands.success(self) : Brands.failure(self)),
    ),
    "effect/Exit:filterValue": onExit("Exit.filterValue", 1, (exit, _, __, self) =>
      Effect.succeed("value" in exit ? Brands.success(exit.value) : Brands.failure(self)),
    ),
    "effect/Exit:filterFailure": onExit("Exit.filterFailure", 1, (exit, _, __, self) =>
      Effect.succeed("value" in exit ? Brands.failure(self) : Brands.success(self)),
    ),
    "effect/Exit:filterCause": onExit("Exit.filterCause", 1, (exit, _, __, self) =>
      Effect.succeed("value" in exit ? Brands.failure(self) : Brands.success(exit.cause)),
    ),
    "effect/Exit:findError": onExit("Exit.findError", 1, (exit, _, __, self) => {
      const reason = "cause" in exit ? found(exit.cause, "Fail") : undefined;
      return Effect.succeed(
        reason?._tag === "Obj"
          ? Brands.success(reason.fields.error ?? Value.undef)
          : Brands.failure(self),
      );
    }),
    "effect/Exit:findDefect": onExit("Exit.findDefect", 1, (exit, _, __, self) => {
      const reason = "cause" in exit ? found(exit.cause, "Die") : undefined;
      return Effect.succeed(
        reason?._tag === "Obj"
          ? Brands.success(reason.fields.defect ?? Value.undef)
          : Brands.failure(self),
      );
    }),
    // Nothing where every one succeeded: every cause, in one, where any did not.
    "effect/Exit:asVoidAll": ([exits], site) => {
      const items = kit.itemsOf(exits);
      if (!items) return wrongArguments(site, "Exit.asVoidAll");
      const reasons = items.flatMap((exit) =>
        exit._tag === "Obj" && tagOf(exit) === "Failure"
          ? (reasonsOf(exit.fields.cause) ?? [])
          : [],
      );
      return Effect.succeed(
        reasons.length === 0
          ? success(Value.undef)
          : Value.obj({ _tag: Value.str("Failure"), cause: Value.obj({ reasons: arr(reasons) }) }),
      );
    },
    "effect/Exit:failCause": ([cause], site) =>
      reasonsOf(cause) && cause
        ? Effect.succeed(Value.obj({ _tag: Value.str("Failure"), cause }))
        : wrongArguments(site, "Exit.failCause"),
    "effect/Exit:interrupt": () =>
      Effect.succeed(failure(Value.obj({ _tag: Value.str("Interrupt") }))),
    "effect/Cause:interrupt": () =>
      Effect.succeed(causeOf(Value.obj({ _tag: Value.str("Interrupt") }))),
  };

  /** Values of the two modules that are not functions. */
  const values: Readonly<Record<string, V>> = {
    "effect/Exit:void": success(Value.undef),
    "effect/Cause:empty": Value.obj({ reasons: arr([]) }),
  };

  return { models, values };
};
