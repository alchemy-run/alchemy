import * as AI from "alchemy/AI";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as S from "effect/Schema";
import { nameOfKey } from "../Root.ts";
import { Calls } from "./Call.ts";

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
 * (`[ask head > engineering-manager] …`), so every hop knows its
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
 * group-local name (`head`, `engineering-manager`, `e-4f2a`) to a
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

const HEADER = /^\[ask ([^\]]+)\]/;

/** The delivered form: the chain header, then the question. */
export const withChain = (
  chain: ReadonlyArray<string>,
  question: string,
): string => `[ask ${chain.join(" > ")}]\n${question}`;

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

/** The chain this session is currently answering (the latest ask
 *  header in its transcript), else the empty chain. */
const currentChain = Effect.gen(function* () {
  const thread = yield* currentThread;
  const entries = yield* thread.entries;
  for (let index = entries.length - 1; index >= 0; index--) {
    const match = HEADER.exec(textOf(entries[index]));
    if (match !== null) {
      return match[1]!.split(">").map((name) => name.trim());
    }
  }
  return [] as ReadonlyArray<string>;
});

const agent = AI.Thing("agent", S.String)`
  The teammate to ask, by name — "head", a role like
  "engineering-manager", or a spawned engineer like "e-4f2a". One
  target per question.`;

const question = AI.Thing("question", S.String)`
  ONE question, self-contained: everything the target needs to answer
  without your context (they do not see your conversation).`;

const answer = AI.Thing("answer", S.String)`
  The target's settled answer — it may have asked others to produce it.`;

const call = AI.Thing("call", S.optionalKey(S.String))`
  A call id (from the call tool): the exchange is mirrored into that
  call's thread, where the humans watch and can join.`;

const note = AI.Thing("note", S.String)`
  A short note — context, a heads-up, a report. No answer expected.`;

export class Ask extends (AI.Tool<Ask>(import.meta)("ask")`
  Ask ${agent} one ${question} and wait for the ${AI.out(answer)}. The
  target may ask others while answering — the chain bubbles back to
  you. Refused (${ChainRefused}) when the chain would cycle or the hop
  budget is spent: answer with what you have. Unknown names fail with
  ${TeammateUnknown} and the roster. Pass ${call} to hold the exchange
  in a call's thread.`) {}

export class Tell extends (AI.Tool<Tell>(import.meta)("tell")`
  Leave ${agent} a ${note} — fire-and-forget; no answer, no waiting
  (use ask when you need one). The note lands in their session.
  Unknown names fail with ${TeammateUnknown} and the roster.`) {}

/** The ask physics: resolve, guard the chain, dispatch, bubble up. */
export const AskLive = Layer.effect(
  Ask,
  Effect.gen(function* () {
    const colleagues = yield* Colleagues;
    const sessions = yield* AI.Sessions;
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
      const behind = yield* currentChain;
      const chain = behind.includes(myName) ? behind : [...behind, myName];
      const target = yield* colleagues.resolve(p.agent);
      if (chain.includes(target.name) || chain.length >= MAX_HOPS) {
        return yield* new ChainRefused({ chain, target: target.name });
      }
      yield* mirror(p.call, myName, `→ ${target.name}: ${p.question}`);
      const outcome = yield* sessions.dispatch(
        target.term,
        target.key,
        withChain([...chain, target.name], p.question),
        { parent: { term: target.term, key: me.key } },
      );
      const text =
        typeof outcome === "string" ? outcome : JSON.stringify(outcome);
      const clipped =
        text.length > 8_000 ? `${text.slice(0, 8_000)}\n[… clipped]` : text;
      yield* mirror(p.call, target.name, clipped);
      return { answer: clipped };
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
