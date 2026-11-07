import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** A Daytona object did not reach the state it was waiting for. */
export class StateTimeout extends Data.TaggedError("Daytona.StateTimeout")<{
  readonly kind: string;
  readonly id: string;
  readonly want: readonly string[];
  readonly last: string | undefined;
}> {
  override get message() {
    return `Daytona ${this.kind} ${this.id} did not reach ${this.want.join(" | ")} (last state: ${this.last ?? "unknown"})`;
  }
}

/** A Daytona object reached a failure state. */
export class StateFailed extends Data.TaggedError("Daytona.StateFailed")<{
  readonly kind: string;
  readonly id: string;
  readonly state: string;
  readonly reason: string | undefined;
}> {
  override get message() {
    return `Daytona ${this.kind} ${this.id} is ${this.state}${this.reason ? `: ${this.reason}` : ""}`;
  }
}

/**
 * Poll `observe` until its state is one of `want`, failing fast on one of
 * `fail`. Bounded by `budget` (spaced polls, capped at 5 s apart).
 */
export const waitForState = <A extends { readonly state?: string | undefined }, E, R>(options: {
  readonly kind: string;
  readonly id: string;
  readonly observe: Effect.Effect<A, E, R>;
  readonly want: readonly string[];
  readonly fail?: readonly string[];
  readonly reason?: (a: A) => string | null | undefined;
  readonly budget?: Duration.Input;
}): Effect.Effect<A, E | StateTimeout | StateFailed, R> => {
  const budget = Duration.fromInputUnsafe(options.budget ?? "5 minutes");
  const fail = options.fail ?? ["error", "build_failed"];
  let last: string | undefined;
  return options.observe.pipe(
    Effect.flatMap((a) => {
      last = a.state;
      if (a.state !== undefined && fail.includes(a.state)) {
        return Effect.fail(
          new StateFailed({
            kind: options.kind,
            id: options.id,
            state: a.state,
            reason: options.reason?.(a) ?? undefined,
          }),
        );
      }
      return Effect.succeed(a);
    }),
    Effect.repeat({
      schedule: Schedule.min([
        Schedule.exponential("500 millis", 1.5),
        Schedule.spaced("5 seconds"),
      ]).pipe(Schedule.upTo({ duration: budget })),
      until: (a) => a.state !== undefined && options.want.includes(a.state),
    }),
    Effect.flatMap((a) =>
      a.state !== undefined && options.want.includes(a.state)
        ? Effect.succeed(a)
        : Effect.fail(
            new StateTimeout({ kind: options.kind, id: options.id, want: options.want, last }),
          ),
    ),
  );
};

/** Poll until `exists` reports false (a typed not-found mapped to `false`). */
export const waitUntilGone = <E, R>(
  kind: string,
  id: string,
  exists: Effect.Effect<boolean, E, R>,
  budget: Duration.Input = "2 minutes",
): Effect.Effect<void, E | StateTimeout, R> =>
  exists.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds").pipe(
        Schedule.upTo({ duration: Duration.fromInputUnsafe(budget) }),
      ),
      until: (present) => !present,
    }),
    Effect.flatMap((present) =>
      present
        ? Effect.fail(new StateTimeout({ kind, id, want: ["deleted"], last: "present" }))
        : Effect.void,
    ),
  );

/** Minutes for Daytona's interval fields (`0` disables). */
export const toMinutes = (d: Duration.Input | undefined): number | undefined =>
  d === undefined ? undefined : Math.round(Duration.toMinutes(Duration.fromInputUnsafe(d)));

/** Whole seconds, for Daytona's command timeouts. */
export const toSeconds = (d: Duration.Input | undefined): number | undefined =>
  d === undefined ? undefined : Math.ceil(Duration.toSeconds(Duration.fromInputUnsafe(d)));
