import * as AI from "alchemy/AI";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { nameOfKey } from "../Lineage.ts";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * A CALL — an agent calls 1..* teammates into a conversation.
 *
 * Nothing new happens mechanically: the call is DRIVEN BY ASKS between
 * members, starting with the initiator; every utterance is one agent's
 * ask or answer — the multi-agent problem is resolved by avoiding it.
 * What the call ADDS is a shared, durable transcript (CallDO): every
 * ask carrying the call id is mirrored into it (Ask.ts), so the whole
 * exchange reads as ONE thread — nested inside the thread where the
 * call began (its tool card), clickable, LIVE (the `/api/calls/:id/live`
 * socket), and JOINABLE: a human post into the call lands in the
 * transcript and is delivered to the member it addresses.
 */

export interface CallUtterance {
  readonly seq: number;
  /** A thread-local name (`head`, `manager`) or the
   *  human's login. */
  readonly author: string;
  readonly text: string;
  readonly at: number;
}

export interface CallView {
  readonly id: string;
  readonly topic: string;
  readonly initiator: string;
  readonly members: ReadonlyArray<string>;
  readonly open: boolean;
  readonly utterances: ReadonlyArray<CallUtterance>;
  readonly createdAt: number;
}

export class Calls extends Context.Service<
  Calls,
  {
    readonly open: (input: {
      readonly initiator: string;
      readonly members: ReadonlyArray<string>;
      readonly topic: string;
    }) => Effect.Effect<string>;
    readonly append: (
      id: string,
      utterance: { readonly author: string; readonly text: string },
    ) => Effect.Effect<void>;
    readonly read: (id: string) => Effect.Effect<CallView | undefined>;
    /** The utterances `member` has not yet seen (excluding its own),
     *  advancing its watermark — the DELTA an ask on the call delivers
     *  as pre-history, so a member receives the meeting exactly once,
     *  as the sequence of messages it is. */
    readonly since: (
      id: string,
      member: string,
    ) => Effect.Effect<ReadonlyArray<CallUtterance>>;
    /** The call's live view — a WebSocket upgrade. */
    readonly socket: (
      id: string,
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("Calls") {}

const members = AI.Thing("members", S.Array(S.String))`
  The teammates to call in, by name (as ask addresses them).`;

const topic = AI.Thing("topic", S.String)`
  What the call is about — one line; it heads the call's thread.`;

const callId = AI.Thing("call", S.String)`
  The call's id: pass it to ask so every exchange lands in the call;
  the humans watch the thread live and can join it.`;

/**
 * The call tool — a CLASS tool so it rides the typed wire (renderer
 * coverage, `AI.ToolNames`). A call is not "ended" by a tool: it has
 * served its purpose when its initiator stops asking on it — the
 * initiator's closing ask (or its answer upward) is the record's last
 * word.
 */
export class Call extends (AI.Tool<Call>(import.meta)("call")`
  Call ${members} into a conversation about ${topic} — a HUDDLE, for
  when one exchange with one teammate is not enough (several
  teammates, or sustained back-and-forth). To ask ONE teammate one
  thing, just ask — never open a call for it. You speak first: drive
  it with ask, passing the ${AI.out(callId)} it answers, so every
  exchange lands in the call's thread — the humans watch it live and
  can join. One agent acts at a time; the call is the record.`) {}

export const CallToolLive = Layer.effect(
  Call,
  Effect.gen(function* () {
    const calls = yield* Calls;
    return Effect.fn(function* (p: {
      members: ReadonlyArray<string>;
      topic: string;
    }) {
      const me = Option.getOrUndefined(
        yield* Effect.serviceOption(AI.Thread),
      );
      if (me === undefined) {
        return yield* Effect.die("call outside a session frame");
      }
      const id = yield* calls.open({
        initiator: nameOfKey(me.key),
        members: [...p.members],
        topic: p.topic,
      });
      return { call: id };
    });
  }),
);
