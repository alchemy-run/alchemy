/**
 * Which of an instance's calls wait on the current one, so a call that can
 * only run once they finish fails at once instead of deadlocking.
 *
 * A transaction holds its instance's input gate until it finishes, and
 * construction holds back every call until it finishes. Each is a section
 * with a token naming it, sent with every call made from inside it and
 * passed on by the instances those calls reach. A call that comes back to
 * the instance while the section its token names is still open would wait
 * on that section, which waits on the call: it fails with
 * {@link DurableObjectDeadlock} instead, answered as HTTP 508.
 *
 * @internal
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/** The header a call carries the tokens of the sections waiting on it in. */
export const AWAITING_HEADER = "x-alchemy-rivet-awaiting";

/** HTTP 508 Loop Detected: what a call that would deadlock is answered with. */
export const DEADLOCK_STATUS = 508;

/**
 * A call back into an instance that can't run until a section waiting on it
 * finishes: a transaction, or the instance's construction.
 */
export class DurableObjectDeadlock extends Data.TaggedError("Rivet.DurableObjectDeadlock")<{
  readonly message: string;
}> {}

/** A section of this instance the current fiber runs in. */
interface Section {
  readonly token: string;
  readonly open: () => boolean;
}

interface Awaiting {
  /** Sections, on any instance, waiting on the call this fiber serves. */
  readonly received: ReadonlyArray<string>;
  /** Sections of this instance the fiber runs inside. */
  readonly own: ReadonlyArray<Section>;
}

export const Awaiting = Context.Reference<Awaiting>("Rivet/Calls/Awaiting", {
  defaultValue: () => ({ received: [], own: [] }),
});

/** Serve a call that carried `header`. */
export const receive = (header: string | null | undefined): Awaiting => ({
  received: header?.split(",").filter((token) => token.length > 0) ?? [],
  own: [],
});

/** The header value a call made from the current fiber carries. */
export const awaitingHeader: Effect.Effect<string | undefined> = Effect.map(
  Awaiting,
  ({ received, own }) => {
    const tokens = [
      ...received,
      ...own.filter((section) => section.open()).map((section) => section.token),
    ];
    return tokens.length === 0 ? undefined : tokens.join(",");
  },
);

/** One actor activation: the sections open on it. */
export interface Activation {
  readonly id: string;
  /** The token construction runs under. */
  readonly construction: string;
  readonly open: Set<string>;
  next: number;
}

export const makeActivation = (): Activation => {
  const id = crypto.randomUUID();
  const construction = `${id}:construct`;
  return { id, construction, open: new Set([construction]), next: 0 };
};

/** Open a section on `activation`; close it by deleting its token. */
export const openSection = (activation: Activation): Section => {
  const token = `${activation.id}:${activation.next++}`;
  activation.open.add(token);
  return { token, open: () => activation.open.has(token) };
};

/** Run `effect` inside `section`: calls it makes carry its token. */
export const within =
  (section: Section) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Awaiting, (awaiting) =>
      Effect.provideService(effect, Awaiting, {
        received: awaiting.received,
        own: [...awaiting.own, section],
      }),
    );

/** The open section of `activation` waiting on the current call, if any. */
export const waitingSection = (activation: Activation, received: ReadonlyArray<string>) =>
  received.find((token) => activation.open.has(token));

/**
 * Die when a section of `activation` waits on the current call: it holds the
 * input gate, so the call's storage would wait on it forever.
 */
export const notAwaited = (activation: Activation): Effect.Effect<void> =>
  Effect.flatMap(Awaiting, ({ received }) =>
    waitingSection(activation, received) === undefined
      ? Effect.void
      : Effect.die(
          new DurableObjectDeadlock({
            message:
              "A transaction on this Durable Object waits on this call, so its storage can't run until the transaction finishes. Don't call back into a Durable Object from its own transaction.",
          }),
        ),
  );

/** Whether `cause` is a call that would have deadlocked. */
export const isDeadlock = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some(
    (reason) =>
      Cause.isDieReason(reason) &&
      typeof reason.defect === "object" &&
      reason.defect !== null &&
      (reason.defect as { _tag?: unknown })._tag === "Rivet.DurableObjectDeadlock",
  );
