import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Schema from "effect/Schema";
import type * as Aggregate from "./Aggregate.ts";
import * as Command from "./Command.ts";
import { type Filter, matches } from "./Filter.ts";
import { decodeEnvelope, type Kernel } from "./Kernel.ts";
import type { Json, Push, StoredEvent, Subscription, ViewEntry, ViewSnapshot } from "./Platform.ts";
import type * as Read from "./Read.ts";
import { contractOf, nameOf, readRpcs } from "./ReadRpcs.ts";
import * as RequestContext from "./RequestContext.ts";
import type * as View from "./View.ts";

/**
 * Pushing to live reads. A platform that holds subscriptions on its objects
 * (a WebSocket per `watch` or `events` read, on the Durable Object that owns
 * the key) asks these functions what to send after each commit. They judge
 * the change with the read's `validate`, apply its filter, and encode Effect
 * RPC messages, so a client reads a pushed stream exactly like a streamed
 * response.
 *
 * @internal
 */

interface Codecs {
  readonly chunk: (values: ReadonlyArray<unknown>) => Effect.Effect<Json, Schema.SchemaError>;
  readonly exit: (exit: Exit.Exit<void, unknown>) => Effect.Effect<Json, Schema.SchemaError>;
}

const codecCache = new WeakMap<object, Codecs>();

/** The JSON codecs Effect RPC uses for a stream RPC's chunks and exit. */
const codecsOf = (rpc: Rpc.Any): Codecs => {
  const cached = codecCache.get(rpc);
  if (cached) return cached;
  const props = rpc as Rpc.AnyWithProps;
  const success = RpcSchema.isStreamSchema(props.successSchema)
    ? props.successSchema.success
    : Schema.Any;
  const codecs: Codecs = {
    chunk: Schema.encodeUnknownEffect(
      Schema.toCodecJson(Schema.NonEmptyArray(success)),
    ) as Codecs["chunk"],
    exit: Schema.encodeUnknownEffect(
      Schema.toCodecJson(Rpc.exitSchema(rpc as Rpc.AnyWithProps)),
    ) as Codecs["exit"],
  };
  codecCache.set(rpc, codecs);
  return codecs;
};

/** Encode a read's refusal (a middleware error) as the `Exit` that ends it. */
export const refuse = (rpc: Rpc.Any, error: unknown): Effect.Effect<Json, Schema.SchemaError> =>
  codecsOf(rpc).exit(Exit.fail(error));

type Validate = (request: Read.Request<unknown>, state: unknown) => Effect.Effect<void, unknown>;

/** One item to push: the value to send (if the filter keeps it) and the state to judge. */
interface Item {
  readonly state: unknown;
  readonly value: Option.Option<unknown>;
}

/**
 * Judge each item in order and encode what passes: one `Chunk` of the kept
 * values, then, if `validate` rejected an item, the `Exit` that ends the read.
 */
const encode = (
  entry: View.Any | Aggregate.Any,
  subscription: Subscription,
  ref: Aggregate.Ref,
  items: ReadonlyArray<Item>,
  cursor: number,
): Effect.Effect<Push> =>
  Effect.gen(function* () {
    const rpcs = readRpcs(entry);
    const rpc = subscription.mode === "watch" ? rpcs.watch : rpcs.events;
    const codecs = codecsOf(rpc);
    const validate = contractOf(entry).validate as Validate | undefined;
    const context = RequestContext.restore(subscription.context);
    const values: Array<unknown> = [];
    let rejection: Option.Option<unknown> = Option.none();
    for (const item of items) {
      if (validate) {
        const judged = yield* validate({ mode: subscription.mode, key: ref }, item.state).pipe(
          Effect.provideContext(context),
          Effect.result,
        );
        if (judged._tag === "Failure") {
          rejection = Option.some(judged.failure);
          break;
        }
      }
      if (Option.isSome(item.value)) values.push(item.value.value);
    }
    const messages: Array<Json> = [];
    if (values.length > 0) {
      messages.push({
        _tag: "Chunk",
        requestId: subscription.requestId,
        values: yield* codecs.chunk(values),
      });
    }
    if (Option.isSome(rejection)) {
      messages.push({
        _tag: "Exit",
        requestId: subscription.requestId,
        exit: yield* codecs.exit(Exit.fail(rejection.value)),
      });
    }
    return {
      messages,
      subscription: { ...subscription, cursor },
      done: Option.isSome(rejection),
    };
  }).pipe(Effect.orDie);

const where = (subscription: Subscription) => subscription.where as Filter<unknown> | undefined;

/** What a view key's subscriber receives after a commit (or when it connects). */
export const viewPush =
  (kernel: Kernel, view: View.Any) =>
  (
    key: string,
    subscription: Subscription,
    snapshot: ViewSnapshot,
    entries: ReadonlyArray<ViewEntry>,
  ): Effect.Effect<Push> =>
    Effect.suspend(() => {
      const ref = { aggregate: view.definition.key.aggregateName, id: key } as Aggregate.Ref;
      if (subscription.mode === "watch") {
        if (snapshot.version <= subscription.cursor) {
          return Effect.succeed({ messages: [], subscription, done: false });
        }
        const state = snapshot.state === null ? null : kernel.decodeViewState(view, snapshot.state);
        const visible = state !== null && matches(where(subscription), state) ? state : null;
        return encode(
          view,
          subscription,
          ref,
          [{ state, value: Option.some(visible) }],
          snapshot.version,
        );
      }
      const fresh = entries.filter((entry) => entry.seq > subscription.cursor);
      const items = fresh.map((stored): Item => {
        const decoded = kernel.decodeViewEntry(view, stored);
        return {
          state: decoded.state,
          value: matches(where(subscription), decoded.event) ? Option.some(decoded) : Option.none(),
        };
      });
      const cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.seq : subscription.cursor;
      return encode(view, subscription, ref, items, cursor);
    });

/** What an aggregate instance's subscriber receives after a commit (or when it connects). */
export const aggregatePush =
  (kernel: Kernel, aggregate: Aggregate.Any) =>
  (
    id: string,
    subscription: Subscription,
    current: { readonly state: Json | null; readonly version: number },
    events: ReadonlyArray<StoredEvent>,
  ): Effect.Effect<Push> =>
    Effect.suspend(() => {
      const ref = { aggregate: nameOf(aggregate), id } as Aggregate.Ref;
      const state = kernel.decodeState(aggregate, current.state);
      if (subscription.mode === "watch") {
        if (current.version <= subscription.cursor) {
          return Effect.succeed({ messages: [], subscription, done: false });
        }
        return encode(
          aggregate,
          subscription,
          ref,
          [{ state, value: Option.some(state) }],
          current.version,
        );
      }
      const fresh = events.filter((stored) => stored.envelope.seq > subscription.cursor);
      // Judged against the instance's state now, since events carry no state.
      const items = fresh.map((stored): Item => ({
        state,
        value: Option.some({
          event: kernel.decodeEvent(stored.event),
          envelope: decodeEnvelope(stored.envelope),
        }),
      }));
      const cursor = fresh.length > 0 ? fresh[fresh.length - 1]!.envelope.seq : subscription.cursor;
      return encode(aggregate, subscription, ref, items, cursor);
    });
