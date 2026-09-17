import * as AI from "alchemy/AI";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { nameOfKey } from "../Lineage.ts";
import { Posts } from "./Posts.ts";
import { Calls } from "./Call.ts";

/**
 * ASK — conversation as function calling, the ONLY way agents talk.
 *
 * One MESSAGE, addressed by @MENTION: every agent the text mentions
 * ("@reviewer please look at PR #12") receives it and answers. Each
 * target answers — and while answering it is free to ask someone
 * else: a chain is nested blocking dispatches (the proven spawn
 * pattern), so answers bubble up like return values — to the Head,
 * then to the human. The mention is the routing AND the rendering:
 * the humans read the text as a plain conversation, chips where the
 * names are.
 *
 * Ancestry is STRUCTURAL, never in-band: the delivered message's id
 * IS the ask's post id (`Sessions.dispatch` carries an identified
 * `AI.Message`), the target reads what it is answering from
 * `AI.Thread.invocations` (the round's admitted messages), and the
 * cycle/hop guard walks the reply-reference chain — a chain deeper
 * than {@link MAX_HOPS} or one that would cycle is refused
 * model-visibly, so the asker answers with what it has instead of
 * recursing forever.
 */

/** The most hops a question may travel from the Root Group's channel. */
export const MAX_HOPS = 8;

export class ChainRefused extends Data.TaggedError("ChainRefused")<{
  readonly chain: ReadonlyArray<string>;
  readonly target: string;
}> {
  override get message(): string {
    return this.chain.includes(this.target)
      ? `asking ${this.target} would cycle (the chain is ${this.chain.join(" > ")}) — answer with what you have`
      : `the ask chain is ${this.chain.length} hops deep (${this.chain.join(" > ")}) — the budget is ${MAX_HOPS}; answer with what you have`;
  }
}

export class TeammateUnknown extends Data.TaggedError("TeammateUnknown")<{
  readonly member: string;
  readonly roster: ReadonlyArray<string>;
}> {
  override get message(): string {
    return `no teammate named '${this.member}' — the team is: ${this.roster.join(", ")}`;
  }
}

/** An ask with nobody mentioned goes nowhere — refused, visibly. */
export class NoMention extends Data.TaggedError("NoMention") {
  override get message(): string {
    return (
      "REFUSED: the ask mentions nobody — address every agent you're " +
      'asking with @name in the text ("@reviewer please review PR ' +
      '#12 on ws-stripe") and send again'
    );
  }
}

/** How agents are addressed IN TEXT — `@reviewer`, `@engineer`. The
 *  same convention the UI renders as mention chips. */
export const MENTION = /(?<![\w@.])@([a-z][a-z0-9-]{0,40})\b/g;

/** Every distinct name the text mentions, in order of appearance. */
export const mentionsOf = (text: string): ReadonlyArray<string> => [
  ...new Set([...text.matchAll(MENTION)].map((match) => match[1]!)),
];

/**
 * The COLLEAGUES a session can address: the whole company, resolved by
 * agent name (`head`, `manager`, `engineer`, `reviewer`) to a
 * session ADDRESS — a term and a key, pure data (`Sessions.dispatch`
 * does the talking). The roster is STATIC (the org chart is code);
 * identity is one, sessions are many: pass `invocation` (the ask's
 * post id) and a worker role answers in a session OF ITS OWN for
 * that message — each response gets its own separate space to work
 * in, starting from zero (context is restored by exploring the
 * message graph, not carried in session memory). Channel residents
 * (head, manager) keep one session — their session IS the channel.
 * Implemented once for the company in engineering/Group.ts — the
 * seam that keeps `Ask` ignorant of the org chart.
 */
export class Colleagues extends Context.Service<
  Colleagues,
  {
    readonly resolve: (
      name: string,
      options?: { readonly invocation?: string },
    ) => Effect.Effect<
      {
        readonly name: string;
        /** The target's session term (its agent). */
        readonly term: string;
        /** The target's session key (its lineage under the root). */
        readonly key: string;
      },
      TeammateUnknown
    >;
  }
>()("Colleagues") {}

/** The calling SESSION — tool physics are Layers (built once per
 *  isolate), so the session is read from the ambient frame at CALL
 *  time; its absence is a wiring defect, never a model-visible error. */
const currentThread = Effect.gen(function* () {
  const thread = Option.getOrUndefined(yield* Effect.serviceOption(AI.Thread));
  return thread === undefined
    ? yield* Effect.die("ask/tell outside a session frame")
    : thread;
});

/** The post this session's CURRENT round is answering — the newest
 *  invocation whose message id is a post (an ask delivered it with
 *  the post id as the message id). Structural and round-scoped:
 *  `AI.Thread.invocations` is the round's admitted messages, so a
 *  stale ask earlier in the transcript can never claim the edge. */
export const currentAsk = Effect.gen(function* () {
  const thread = yield* currentThread;
  const invocations = yield* thread.invocations;
  for (let index = invocations.length - 1; index >= 0; index--) {
    const id = invocations[index]!.id;
    if (id.startsWith("p-")) return id;
  }
  return undefined;
});

const agent = AI.Thing("agent", S.String)`
  The teammate, by name — "head", "manager", "engineer", "reviewer".`;

const text = AI.Thing("text", S.String)`
  Your message, written the way you'd talk to colleagues — and
  ADDRESSED with @mentions: EVERY agent you mention ("@reviewer",
  "@engineer", "@manager") receives this text and answers it. The
  responder starts from ZERO — it sees this message only, and
  explores the thread for anything else it needs — so lead with the
  point and name the essentials (paths, ids, what DONE means).`;

const answers = AI.Thing(
  "answers",
  S.Array(
    S.Struct({
      agent: S.String,
      post: S.String,
      answer: S.String,
    }),
  ),
)`
  One entry per mentioned agent: its answer, and that reply's post id
  in the company's thread.`;

const postId = AI.Thing("post", S.String)`
  Your message's post id — the root of the thread the humans read.`;

const call = AI.Thing("call", S.optionalKey(S.String))`
  A call id (from the call tool): the exchange is mirrored into that
  call's thread, where the humans watch and can join.`;

const note = AI.Thing("note", S.String)`
  A short note — context, a heads-up, a report. No answer expected.`;

export class Ask extends (AI.Tool<Ask>(import.meta)("ask")`
  Say ${text} to the agents it @mentions and wait for their
  ${AI.out(answers, postId)} — every mentioned agent is asked; each may ask
  others while answering, and the chains bubble back to you. The
  whole exchange renders as a THREAD the humans read — never paste an
  answer back into your reply; reference the outcome in one line at
  most. Refused: ${NoMention} when the text mentions nobody;
  ${ChainRefused} when a chain would cycle or the hop budget is spent
  (answer with what you have); unknown names fail with
  ${TeammateUnknown} and the roster. Pass ${call} to hold the
  exchange in a call's thread.`) {}

export class Tell extends (AI.Tool<Tell>(import.meta)("tell")`
  Leave ${agent} a ${note} — fire-and-forget; no answer, no waiting
  (use ask when you need one). The note lands in their session.
  Unknown names fail with ${TeammateUnknown} and the roster.`) {}

/** The ask physics: resolve, guard the chain, record the tree node,
 *  deliver (with the call's DELTA as pre-history when on one), settle
 *  the node with the answer, bubble it up. */
export const AskLive = Layer.effect(
  Ask,
  Effect.gen(function* () {
    const colleagues = yield* Colleagues;
    const sessions = yield* AI.Sessions;
    const posts = yield* Posts;
    const calls = yield* Effect.serviceOption(Calls);

    const mirror = Effect.fn(function* (
      callId: string | undefined,
      author: string,
      text: string,
    ) {
      if (callId === undefined || Option.isNone(calls)) return;
      yield* calls.value.append(callId, { author, text }).pipe(Effect.ignore);
    });

    return Effect.fn(function* (p: { text: string; call?: string }) {
      const me = yield* currentThread;
      const myName = nameOfKey(me.key);
      const parent = yield* currentAsk;
      // the message being answered carries the channel the whole
      // exchange streams into
      const parentPost =
        parent === undefined ? undefined : yield* posts.get(parent);
      // the reference chain BEHIND this ask — structural (no header
      // to parse, nothing to go stale); its first link is the THREAD
      // this exchange lives in
      const above = parent === undefined ? [] : yield* posts.ancestors(parent);
      const behind = above.map((ancestor) => ancestor.author);
      const chain = behind.includes(myName) ? behind : [...behind, myName];

      // ONE post id for the message, minted up front — it IS the
      // invocation: each target answers in a fresh session of its
      // own for exactly this message
      const minted = yield* Clock.currentTimeMillis;
      const postId = `p-${minted.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

      // WHO the text addresses — the @mentions ARE the routing; a
      // worker role gets its own separate space to work in per
      // message (it starts from zero and explores the graph for
      // context)
      const names = mentionsOf(p.text);
      if (names.length === 0) return yield* new NoMention();
      const targets = yield* Effect.forEach(names, (name) =>
        colleagues.resolve(name, { invocation: postId }),
      );
      for (const target of targets) {
        if (chain.includes(target.name) || chain.length >= MAX_HOPS) {
          return yield* new ChainRefused({ chain, target: target.name });
        }
      }
      // on a call: the asker and every target must be MEMBERS
      if (p.call !== undefined && Option.isSome(calls)) {
        const view = yield* calls.value.read(p.call);
        if (view === undefined) {
          return yield* new TeammateUnknown({
            member: `call ${p.call}`,
            roster: ["(no such call — open one with the call tool)"],
          });
        }
        const missing = [myName, ...targets.map((target) => target.name)].find(
          (name) => !view.members.includes(name),
        );
        if (missing !== undefined) {
          return yield* new TeammateUnknown({
            member: missing,
            roster: view.members,
          });
        }
      }

      // ONE post for the message — the targets' answers reference it,
      // so the text (and the @mentions addressing it) is written and
      // rendered exactly once, however many agents it asks
      const channel = parentPost?.channel;
      yield* posts
        .post({
          id: postId,
          ...(parent !== undefined ? { replyTo: parent } : {}),
          ...(channel !== undefined ? { channel } : {}),
          author: myName,
          kind: "ask",
          text: p.text,
        })
        .pipe(Effect.ignore);
      yield* mirror(p.call, myName, p.text);

      const askOne = Effect.fn(function* (target: {
        readonly name: string;
        readonly term: string;
        readonly key: string;
      }) {
        // on a call: the target receives the meeting-so-far it has
        // not yet seen — one AUTHORED message per utterance (its own
        // words never echoed back). Attribution is structural
        // (`Message.author`), and the stable per-utterance id makes
        // redelivery idempotent. The ask itself was mirrored into
        // the call transcript just above — the target receives it as
        // THE message below, never again as history.
        let history: ReadonlyArray<AI.Message> | undefined;
        if (p.call !== undefined && Option.isSome(calls)) {
          const delta = yield* calls.value.since(p.call, target.name);
          history = delta
            .filter(
              (utterance) =>
                !(utterance.author === myName && utterance.text === p.text),
            )
            .map((utterance) => ({
              id: `${p.call}#${utterance.seq}`,
              author: utterance.author,
              content: utterance.text,
            }));
        }

        // the target's REPLY is its own post under the message —
        // written when the answer lands (or when the chain breaks),
        // so a thread reads: the message, then who said what back
        const replyId = `${postId}-${target.name}`;
        const outcome = yield* sessions
          .dispatch(
            target.term,
            target.key,
            // the delivered message IS the post: same id (the tree
            // edge nested asks parent onto), same author, same text
            { id: postId, author: myName, content: p.text },
            {
              parent: { term: target.term, key: me.key },
              ...(history !== undefined && history.length > 0
                ? { history }
                : {}),
            },
          )
          .pipe(
            Effect.tapDefect((defect) =>
              posts
                .post({
                  id: replyId,
                  replyTo: postId,
                  ...(channel !== undefined ? { channel } : {}),
                  author: target.name,
                  text: String(defect).slice(0, 2_000),
                  status: "failed",
                })
                .pipe(Effect.ignore),
            ),
          );

        const answerText =
          typeof outcome === "string" ? outcome : JSON.stringify(outcome);
        const clipped =
          answerText.length > 8_000
            ? `${answerText.slice(0, 8_000)}\n[… clipped]`
            : answerText;
        yield* posts
          .post({
            id: replyId,
            replyTo: postId,
            ...(channel !== undefined ? { channel } : {}),
            author: target.name,
            text: clipped,
            status: "settled",
          })
          .pipe(Effect.ignore);
        yield* mirror(p.call, target.name, clipped);
        return { agent: target.name, post: replyId, answer: clipped };
      });

      // every mentioned agent answers — concurrently, the way a
      // message to several colleagues lands on all of them at once.
      // The post settles on EVERY exit: a cut round (the operator's
      // stop interrupting this handler) or a failure leaves the post
      // `failed`, never spinning forever — the status is data, and
      // this is where the data is known.
      const settled = yield* Effect.all(targets.map(askOne), {
        concurrency: 4,
      }).pipe(
        Effect.onExit((exit) =>
          posts
            .settle(postId, Exit.isSuccess(exit) ? "settled" : "failed")
            .pipe(Effect.ignore),
        ),
      );
      return { answers: settled, post: postId };
    });
  }),
);

export const TellLive = Layer.effect(
  Tell,
  Effect.gen(function* () {
    const colleagues = yield* Colleagues;
    const sessions = yield* AI.Sessions;
    return Effect.fn(function* (p: { agent: string; note: string }) {
      const me = yield* currentThread;
      // a note goes to the agent's STANDING session — worker
      // invocation sessions are born of asks and die with them; a
      // note that needs the working context should be an ask
      const target = yield* colleagues.resolve(p.agent);
      yield* sessions.send(
        target.term,
        target.key,
        `[note from ${nameOfKey(me.key)}]\n${p.note}`,
        { wake: true },
      );
    });
  }),
);
