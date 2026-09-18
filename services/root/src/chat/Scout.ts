import type { RuntimeContext } from "alchemy";
import type * as TypeSafe from "alchemy/TypeSafe";
import * as Effect from "effect/Effect";
import {
  judge,
  needsContextQuestion,
  refersToQuestion,
  type Line,
  type Message,
  type Respondent,
  type Verdict,
} from "./Gate.ts";

/**
 * THE SCOUT — the gate's deliberation loop.
 *
 * A one-glance judgment routes chat well, but a real channel is a
 * GRAPH: messages cite issues and pull requests, follow up on other
 * posts, and lean on threads that finished last week. Deciding "does
 * this deserve a thread, and whose?" can require looking at what the
 * message points to. System One is fast and cheap enough to sit in a
 * loop, so the scout walks, bounded:
 *
 * 1. REFLEX — one fan-out call (Gate.judge): disposition, explicit
 *    thread ask, addressee, subject-closeness — plus `needsContext`,
 *    "does routing this require looking at something it points to?"
 * 2. EXTRACT — code, not judgment: `#123`, `owner/repo#123` and
 *    `#p-…` references are deterministic. Regex finds them for free.
 * 3. RESOLVE — walk the runtime graph: issues and pull requests from
 *    the forge mirror, threads from the post store (root, replies,
 *    participants, settled or live).
 * 4. SEARCH — when the reference is implicit ("that OOM bug we
 *    discussed") the scout lists recent threads and asks WHICH ONE the
 *    message means — a judged graph search, one hop.
 * 5. RE-JUDGE — the same questions again with `evidence` cards in the
 *    state. Reading evidence changes verdicts: "can someone look at
 *    #1651?" is chat until the issue turns out to be an open bug with
 *    a repro; then it is work.
 *
 * Everything stays advisory: any judgment failing falls back to the
 * best verdict so far, and the whole scout is bounded at three System
 * One calls (~450ms worst case) and one graph walk.
 */

/** What a resolved reference looks like to the judgment — one card. */
export interface Evidence {
  readonly ref: string;
  readonly card: string;
}

/** One post as the scout sees it while walking. */
export interface GraphPost {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly replyTo?: string | undefined;
  readonly status: string;
}

/** The slice of the post store the scout walks. */
export interface PostGraph {
  readonly thread: (
    id: string,
  ) => Effect.Effect<ReadonlyArray<GraphPost>, never, RuntimeContext>;
  /** The channel's recent stream — roots AND replies, oldest first. */
  readonly stream: (
    channel: string,
  ) => Effect.Effect<ReadonlyArray<GraphPost>, never, RuntimeContext>;
}

/** The slice of the forge mirror the scout walks. */
export interface IssueGraph {
  readonly get: (
    repo: string,
    number: number,
  ) => Effect.Effect<
    | {
        title: string;
        state: string;
        isPull: boolean;
        merged: boolean;
        labels: ReadonlyArray<string>;
        body: string | null;
      }
    | undefined,
    never,
    RuntimeContext
  >;
}

export interface ScoutDeps {
  readonly query: typeof TypeSafe.SystemOne.Service;
  readonly posts: PostGraph;
  readonly issues: IssueGraph;
  /** `#123` with no owner/repo resolves here. */
  readonly defaultRepo: string;
  /** Routing rubrics per member — derived from the org graph. */
  readonly roles?: Record<
    string,
    { what: string; notFor?: string; examples?: ReadonlyArray<string> }
  >;
  /** Extra questions to fan into the first judgment (same call). */
  readonly extra?: Record<string, TypeSafe.Questions[string]>;
}

/** `#123`, `owner/repo#123` and `#p-…` — extraction is code, not judgment. */
export const referencesOf = (
  text: string,
): ReadonlyArray<
  | { kind: "issue"; repo: string | undefined; number: number }
  | { kind: "post"; id: string }
> => {
  const refs: Array<
    | { kind: "issue"; repo: string | undefined; number: number }
    | { kind: "post"; id: string }
  > = [];
  for (const match of text.matchAll(/([\w.-]+\/[\w.-]+)?#(p-[\w-]+|\d+)/g)) {
    const [, repo, target] = match;
    if (target!.startsWith("p-")) refs.push({ kind: "post", id: target! });
    else refs.push({ kind: "issue", repo, number: Number(target) });
  }
  return refs.slice(0, 6); // a message citing more is a digest, not a lookup
};

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

/** Resolve every explicit reference into an evidence card. */
const resolveReferences = Effect.fn(function* (
  deps: ScoutDeps,
  refs: ReturnType<typeof referencesOf>,
) {
  const cards: Array<Evidence> = [];
  for (const ref of refs) {
    if (ref.kind === "issue") {
      const repo = ref.repo ?? deps.defaultRepo;
      const issue = yield* deps.issues
        .get(repo, ref.number)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
      if (issue !== undefined) {
        cards.push({
          ref: `${repo}#${ref.number}`,
          card:
            `${issue.isPull ? "pull request" : "issue"} ${repo}#${ref.number} ` +
            `(${issue.merged ? "merged" : issue.state}` +
            `${issue.labels.length > 0 ? `; ${issue.labels.join(", ")}` : ""}): ` +
            `"${clip(issue.title, 120)}"` +
            (issue.body ? ` — ${clip(issue.body, 240)}` : ""),
        });
      }
    } else {
      const posts = yield* deps.posts
        .thread(ref.id)
        .pipe(Effect.catchCause(() => Effect.succeed([])));
      const root = posts[0];
      if (root !== undefined) {
        const authors = [...new Set(posts.map((post) => post.author))];
        cards.push({
          ref: `#${ref.id}`,
          card:
            `thread #${ref.id} (${posts.length} messages; ${authors.join(", ")}; ` +
            `${root.status}): "${clip(root.text, 160)}"`,
        });
      }
    }
  }
  return cards;
});

/** How many threads one search hop offers as answers. A hop carries a
 *  LOT (jev-ultrafast hands whole pages of elements to one Choice);
 *  what it must NOT carry is everything — the graph is unbounded, the
 *  hop's window is not. */
const HOP_WIDTH = 48;

/**
 * The judged graph SEARCH: which recent thread does an implicit
 * reference mean? One WIDE hop — every recent thread of the channel as
 * a candidate, each shown as a card (root text, reply count, served or
 * live) — then a JUMP: the picked thread's own citations (`#123`)
 * resolve too, so "that OOM discussion" brings along the issue the
 * discussion was about.
 */
const searchThreads = Effect.fn(function* (deps: ScoutDeps, state: Message) {
  const stream = yield* deps.posts
    .stream(state.channel)
    .pipe(Effect.catchCause(() => Effect.succeed([])));
  if (stream.length === 0) return [];

  // fold the stream into thread cards — structure the hop chooses on
  const replies = new Map<string, number>();
  for (const post of stream) {
    if (post.replyTo !== undefined) {
      replies.set(post.replyTo, (replies.get(post.replyTo) ?? 0) + 1);
    }
  }
  const roots = stream
    .filter((post) => post.replyTo === undefined && post.id !== state.self)
    .slice(-HOP_WIDTH);
  if (roots.length === 0) return [];

  const candidates = Object.fromEntries([
    ...roots.map((root) => [
      root.id,
      `${root.author}: "${clip(root.text, 140)}" ` +
        `(${replies.get(root.id) ?? 0} replies, ${root.status})`,
    ]),
    ["none", "The message does not refer to any of these"],
  ]) as Record<string, string>;

  const picked = yield* deps
    .query(
      { refersTo: refersToQuestion(candidates) },
      { state: { message: state.message, recent: state.recent } },
    )
    .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
  const choice = picked?.value.refersTo;
  // The SEARCH bar sits below the routing bar (Gate.CONFIDENT) on
  // purpose: probability spreads across however many threads are
  // offered, and the stakes are low — a wrong pick attaches one
  // irrelevant card that the re-judgment reads past, while a missed
  // pick loses the walk entirely.
  const confident = (picked?.answers.refersTo?.confidence ?? 0) >= 0.4;
  if (choice === undefined || choice === "none" || !confident) return [];

  const found = yield* resolveReferences(deps, [{ kind: "post", id: choice }]);

  // the JUMP: what the picked thread itself cites, one deterministic hop
  const thread = yield* deps.posts
    .thread(choice)
    .pipe(Effect.catchCause(() => Effect.succeed([])));
  const cited = referencesOf(thread.map((post) => post.text).join("\n"))
    .filter((ref) => ref.kind === "issue")
    .slice(0, 2);
  return [...found, ...(yield* resolveReferences(deps, cited))];
});

/**
 * Judge a message, walking the graph when the message points beyond
 * itself. Answers the final {@link Verdict} plus the evidence it read
 * (the dispatch hands the same cards to whoever answers).
 */
export const scout = Effect.fn("root/Scout.scout")(function* (
  deps: ScoutDeps,
  state: Message,
) {
  // round 1 — the reflex, plus "do I need to look something up?"
  const first = yield* judge(
    deps.query,
    state,
    { ...deps.extra, needsContext: needsContextQuestion },
    deps.roles,
  );
  if (first === undefined) return undefined;

  // extraction is free; resolution is one graph walk — a message can
  // never be evidence for itself
  const explicit = referencesOf(state.message).filter(
    (ref) => ref.kind !== "post" || ref.id !== state.self,
  );
  let evidence = yield* resolveReferences(deps, explicit);

  // implicit reference, nothing explicit found → one judged search hop
  if (evidence.length === 0 && first.extras.needsContext === true) {
    evidence = yield* searchThreads(deps, state);
  }
  if (evidence.length === 0) {
    return { verdict: first, evidence };
  }

  // round 2 — the same questions, now with the evidence in hand
  const second = yield* judge(
    deps.query,
    { ...state, evidence: evidence.map((card) => card.card) },
    {},
    deps.roles,
  );
  return { verdict: second ?? first, evidence };
});
