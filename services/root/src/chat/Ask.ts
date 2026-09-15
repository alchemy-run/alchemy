import * as AI from "alchemy/AI";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { nameOfKey } from "../Root.ts";
import { Asks } from "./Asks.ts";
import { Calls, renderUtterance } from "./Call.ts";

/**
 * ASK — conversation as function calling, the ONLY way agents talk.
 *
 * One question, ONE target. The target answers — and while answering it
 * is free to ask someone else: the chain is nested blocking dispatches
 * (the proven spawn pattern), so answers bubble up like return values —
 * to the Head, then to the human. The multi-agent problem is resolved
 * by avoiding it: at every moment exactly ONE agent is acting.
 *
 * The chain rides the delivered question as a machine-readable header
 * (`[ask head > manager] …`), so every hop knows its
 * ancestry: a cycle is refused, and a chain deeper than {@link MAX_HOPS}
 * is refused — the refusal is model-visible, so the asker answers with
 * what it has instead of recursing forever.
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

/**
 * The COLLEAGUES a session can address: the whole company, resolved by
 * group-local name (`head`, `manager`, `e-4f2a`) to a
 * session ADDRESS — a term and a key, pure data (`Sessions.dispatch`
 * does the talking). Implemented once for the company (the Group
 * declaration plus the Head) in engineering/Group.ts — the seam that
 * keeps `Ask` ignorant of the org chart.
 */
export class Colleagues extends Context.Service<
  Colleagues,
  {
    readonly resolve: (name: string) => Effect.Effect<
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

const HEADER = /^\[ask ([a-z0-9-]+) \| ([^\]]+)\]/;

/** The delivered form: the ask's ID and its chain, then the question.
 *  The id is the tree edge — an ask made while answering this one
 *  records it as its parent (Asks.ts). */
export const withChain = (
  id: string,
  chain: ReadonlyArray<string>,
  question: string,
): string => `[ask ${id} | ${chain.join(" > ")}]\n${question}`;

/** Pull text out of a prompt message's content, defensively. */
const textOf = (message: unknown): string => {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" &&
      part !== null &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("");
};

/** The calling SESSION — tool physics are Layers (built once per
 *  isolate), so the session is read from the ambient frame at CALL
 *  time; its absence is a wiring defect, never a model-visible error. */
const currentThread = Effect.gen(function* () {
  const thread = Option.getOrUndefined(
    yield* Effect.serviceOption(AI.Thread),
  );
  return thread === undefined
    ? yield* Effect.die("ask/tell outside a session frame")
    : thread;
});

/** The ask this session is currently ANSWERING (the latest ask header
 *  in its transcript): its id (the parent edge for asks made while
 *  answering) and its chain (the cycle/hop guard). */
const currentAsk = Effect.gen(function* () {
  const thread = yield* currentThread;
  const entries = yield* thread.entries;
  for (let index = entries.length - 1; index >= 0; index--) {
    const match = HEADER.exec(textOf(entries[index]));
    if (match !== null) {
      return {
        parent: match[1]!,
        chain: match[2]!.split(">").map((name) => name.trim()),
      };
    }
  }
  return { parent: undefined, chain: [] as ReadonlyArray<string> };
});

const agent = AI.Thing("agent", S.String)`
  The teammate to ask, by name — "head", a role like
  "manager", or a spawned engineer like "e-4f2a". One
  target per question.`;

const question = AI.Thing("question", S.String)`
  ONE question, self-contained: everything the target needs to answer
  without your context (they do not see your conversation).`;

const answer = AI.Thing("answer", S.String)`
  The target's settled answer — it may have asked others to produce it.`;

const askId = AI.Thing("ask", S.String)`
  This ask's id in the company's ask tree — the UI renders the chain
  under it.`;

const call = AI.Thing("call", S.optionalKey(S.String))`
  A call id (from the call tool): the exchange is mirrored into that
  call's thread, where the humans watch and can join.`;

const note = AI.Thing("note", S.String)`
  A short note — context, a heads-up, a report. No answer expected.`;

export class Ask extends (AI.Tool<Ask>(import.meta)("ask")`
  Ask ${agent} one ${question} and wait for the ${AI.out(answer, askId)}. The
  target may ask others while answering — the chain bubbles back to
  you. Refused (${ChainRefused}) when the chain would cycle or the hop
  budget is spent: answer with what you have. Unknown names fail with
  ${TeammateUnknown} and the roster. Pass ${call} to hold the exchange
  in a call's thread.`) {}

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
    const asks = yield* Asks;
    const calls = yield* Effect.serviceOption(Calls);

    const mirror = Effect.fn(function* (
      callId: string | undefined,
      author: string,
      text: string,
    ) {
      if (callId === undefined || Option.isNone(calls)) return;
      yield* calls.value.append(callId, { author, text }).pipe(Effect.ignore);
    });

    return Effect.fn(function* (p: {
      agent: string;
      question: string;
      call?: string;
    }) {
      const me = yield* currentThread;
      const myName = nameOfKey(me.key);
      const { parent, chain: behind } = yield* currentAsk;
      const chain = behind.includes(myName) ? behind : [...behind, myName];
      const target = yield* colleagues.resolve(p.agent);
      if (chain.includes(target.name) || chain.length >= MAX_HOPS) {
        return yield* new ChainRefused({ chain, target: target.name });
      }

      // on a call: the asker and the target must both be MEMBERS, and
      // the target receives the meeting-so-far it has not yet seen —
      // one message per utterance (its own words never echoed back)
      let history: ReadonlyArray<string> | undefined;
      if (p.call !== undefined && Option.isSome(calls)) {
        const view = yield* calls.value.read(p.call);
        if (view === undefined) {
          return yield* new TeammateUnknown({
            member: `call ${p.call}`,
            roster: ["(no such call — open one with the call tool)"],
          });
        }
        if (!view.members.includes(myName) || !view.members.includes(target.name)) {
          return yield* new TeammateUnknown({
            member: target.name,
            roster: view.members,
          });
        }
        const delta = yield* calls.value.since(p.call, target.name);
        history = delta.map((utterance) => renderUtterance(p.call!, utterance));
      }

      const minted = yield* Clock.currentTimeMillis;
      const id = `a-${minted.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      yield* asks
        .open({
          id,
          ...(parent !== undefined ? { parent } : {}),
          ...(p.call !== undefined ? { call: p.call } : {}),
          asker: myName,
          target: target.name,
          question: p.question,
        })
        .pipe(Effect.ignore);
      yield* mirror(p.call, myName, `→ ${target.name}: ${p.question}`);

      const outcome = yield* sessions
        .dispatch(
          target.term,
          target.key,
          withChain(id, [...chain, target.name], p.question),
          {
            parent: { term: target.term, key: me.key },
            ...(history !== undefined && history.length > 0
              ? { history }
              : {}),
          },
        )
        .pipe(
          Effect.tapDefect((defect) =>
            asks
              .settle(id, "failed", String(defect).slice(0, 2_000))
              .pipe(Effect.ignore),
          ),
        );

      const text =
        typeof outcome === "string" ? outcome : JSON.stringify(outcome);
      const clipped =
        text.length > 8_000 ? `${text.slice(0, 8_000)}\n[… clipped]` : text;
      yield* asks.settle(id, "answered", clipped).pipe(Effect.ignore);
      yield* mirror(p.call, target.name, clipped);
      return { answer: clipped, ask: id };
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
