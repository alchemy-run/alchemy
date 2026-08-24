import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { type OperationId, makeOperationId } from "./Surface.ts";

export interface Operation<
  Event extends { readonly _tag: string },
  Error,
  Requirements = never,
> {
  readonly id: OperationId;
  readonly events: Stream.Stream<Event, Error, Requirements>;
}

export type Result<Event> =
  Extract<Event, { readonly _tag: "Succeeded" }> extends {
    readonly result: infer A;
  }
    ? A
    : never;

export type Progress<Event> = Exclude<Event, { readonly _tag: "Succeeded" }>;

/** Add the one universal terminal event to a module-owned progress union. */
export const eventSchema = <
  const Cases extends Record<string, Schema.Struct.Fields>,
  const ResultSchema extends Schema.Top,
>(
  cases: Cases,
  result: ResultSchema,
) =>
  Schema.TaggedUnion({
    ...cases,
    Succeeded: { result },
  });

/**
 * Construct a finite, interruption-owned operation. The work begins when its
 * event stream is consumed, emits exactly one Succeeded value, then ends.
 */
export const make = <Progress extends { readonly _tag: string }, A, E, R>(
  run: (
    emit: (event: Progress) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<
  Operation<
    Progress | { readonly _tag: "Succeeded"; readonly result: A },
    E,
    Exclude<R, import("effect/Scope").Scope>
  >,
  never,
  never
> =>
  Effect.map(makeOperationId, (id) => ({
    id,
    events: Stream.callback<
      Progress | { readonly _tag: "Succeeded"; readonly result: A },
      E,
      R
    >((queue) => {
      const emit = (event: Progress) =>
        Effect.sync(() => {
          Queue.offerUnsafe(queue, event);
        });
      return run(emit).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) => Queue.failCause(queue, cause),
          onSuccess: (result) =>
            Effect.sync(() => {
              Queue.offerUnsafe(queue, { _tag: "Succeeded", result });
              Queue.endUnsafe(queue);
            }),
        }),
      );
    }),
  }));

export const result = <
  Event extends { readonly _tag: string },
  Error,
  Requirements,
>(
  operation: Operation<Event, Error, Requirements>,
): Effect.Effect<Result<Event>, Error, Requirements> =>
  operation.events.pipe(
    Stream.runLast,
    Effect.flatMap((last) =>
      Option.match(last, {
        onNone: () => Effect.die("Operation ended without a Succeeded event"),
        onSome: (event) =>
          event._tag === "Succeeded" && "result" in event
            ? Effect.succeed(event.result as Result<Event>)
            : Effect.die("Operation ended without a Succeeded event"),
      }),
    ),
  );

/** Consume progress and return the terminal result in one stream pass. */
export const run = <
  Event extends { readonly _tag: string },
  Error,
  Requirements,
  ObserverError = never,
  ObserverRequirements = never,
>(
  operation: Operation<Event, Error, Requirements>,
  onProgress: (
    event: Progress<Event>,
  ) => Effect.Effect<void, ObserverError, ObserverRequirements>,
): Effect.Effect<
  Result<Event>,
  Error | ObserverError,
  Requirements | ObserverRequirements
> =>
  operation.events.pipe(
    Stream.runFoldEffect(
      () => Option.none<Result<Event>>(),
      (terminal, event) =>
        event._tag === "Succeeded" && "result" in event
          ? Effect.succeed(Option.some(event.result as Result<Event>))
          : Effect.as(onProgress(event as Progress<Event>), terminal),
    ),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("Operation ended without a Succeeded event"),
        onSome: Effect.succeed,
      }),
    ),
  );
