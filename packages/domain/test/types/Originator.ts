/**
 * Type-level regressions for `Domain.Originator`: it is a request context of
 * the application's own JSON, and the envelope's `originator` is optional and
 * never `undefined`. Compiled, never run.
 */
import * as Domain from "@alchemy.run/domain";
import type * as Aggregate from "@alchemy.run/domain/Aggregate";
import * as Effect from "effect/Effect";
import * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as Schema from "effect/Schema";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(_: T) => {};

// The service holds whatever the application encodes: its value type is `unknown`.
assertType<Equals<Domain.Originator["Service"], unknown>>(true);
export const provided = Effect.provideService(Effect.void, Domain.Originator, { actor: "sam" });
export const providedOther = Effect.provideService(Effect.void, Domain.Originator, ["a", 1]);

declare const envelope: Aggregate.Envelope;

// An envelope may carry an originator or not, and what it carries is not narrowed.
assertType<Equals<typeof envelope.originator, unknown>>(true);
// @ts-expect-error an originator is `unknown` until the application narrows it
export const asString: string = envelope.originator;
// An envelope without an originator omits the key.
export const omitted: Aggregate.Envelope = { ...envelope };

// A middleware may provide it next to the rest of a request's context.
class Unauthorized extends Domain.Rejection("Unauthorized") {}
class Session extends RpcMiddleware.Service<Session, { provides: Domain.Originator }>()(
  "Test/OriginatorSession",
  { error: Unauthorized },
) {}
class Stamped extends Domain.Event("Stamped") {}
export class Stamp extends Domain.Command("Stamp", {
  input: { id: Schema.String },
  events: [Stamped],
  middleware: [Session],
}) {}
