import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { BadRef, makeEntityLookup } from "../github/Entity.ts";
import { connected } from "../github/Repos.ts";
import { ThreadAgent } from "../thread/ThreadAgent.ts";
import { mintThreadId, Threads } from "../thread/Threads.ts";
import { Channel } from "./Channel.ts";

/**
 * The CHANNEL AGENT — the operator's hand on the control plane. It
 * runs on nothing but the operator's messages: `POST /api/channel`
 * appends the message (which mints its `seq`), then dispatches a
 * FRESH session keyed `main@<seq>` — zero standing context. The agent
 * regains whatever it needs by exploring BACKWARDS through the
 * channel with tools clamped to its pin: nothing later than the
 * message it serves exists for it.
 *
 * It is a ROUTER and a LIBRARIAN, never a worker: it reads the
 * channel, creates and shapes threads (place messages, attach
 * entities, brief the thread's agent), and answers the operator. The
 * work itself belongs to thread agents.
 *
 * CODEMODE: its tools are presented as importable functions and a
 * tick is one `eval` of the module the model writes
 * (`AI.CodeModeAsync` over the isolate loader), so a sweep like
 * "find every open dependabot PR and thread them" is one program,
 * not thirty tool calls.
 */
export class ChannelAgent extends AI.Agent<ChannelAgent>(import.meta)(
  "Channel",
) {}

/* ── vocabulary: the ontology the tools are expressions over ────── */

const q = AI.Thing("q", S.String)`
  Substring to search message text for (case-insensitive).`;

const ids = AI.Thing("ids", S.Array(S.String))`
  Channel message ids.`;

const threadId = AI.Thing("thread", S.String)`
  A thread id (t-…).`;

const name = AI.Thing("name", S.String)`
  The thread's short handle for the rail — lowercase, hyphenated,
  2-4 words ("do-init-hang").`;

const title = AI.Thing("title", S.String)`
  One line — what the task is about, in plain words.`;

const text = AI.Thing("text", S.String)`
  The text, complete and self-contained. Markdown.`;

const ref = AI.Thing("ref", S.String)`
  A GitHub entity, fully qualified — "owner/repo#832".`;

const kind = AI.Thing("kind", S.Literals(["issue", "pull"]))`
  What the ref is.`;

const entityTitle = AI.Thing("title", S.String)`
  The entity's title, as GitHub has it.`;

const repo = AI.Thing("repo", S.String)`
  The repository, "owner/repo".`;

const number = AI.Thing("number", S.Int)`
  An issue or pull request number.`;

const limit = AI.Thing("limit", S.optionalKey(S.Int))`
  Most rows to answer (default 50).`;

const before = AI.Thing("before", S.optionalKey(S.Int))`
  A message seq — only rows at or before it.`;

/** One channel row, as every reading tool answers it. */
const MessageRow = S.Struct({
  id: S.String,
  seq: S.Int,
  at: S.Number,
  kind: S.Literals(["event", "user", "agent", "card"]),
  author: S.UndefinedOr(S.Struct({ login: S.String })),
  text: S.String,
  repo: S.optionalKey(S.String),
  ref: S.optionalKey(S.String),
  event: S.optionalKey(S.String),
  thread: S.optionalKey(S.String),
});

const hits = AI.Thing("hits", S.Array(MessageRow))`
  The matching channel messages, newest first.`;

const messages = AI.Thing("messages", S.Array(MessageRow))`
  Channel messages, oldest first.`;

/** A thread, as the directory and the state tools answer it. */
const ThreadRow = S.Struct({
  id: S.String,
  name: S.String,
  title: S.String,
  status: S.Literals(["open", "closed"]),
  turn: S.Literals(["you", "agents", "others", "idle"]),
});

const threadRows = AI.Thing("threads", S.Array(ThreadRow))`
  Every thread in the org: id, name, title, status, whose turn.`;

const state = AI.Thing(
  "state",
  S.Struct({
    ...ThreadRow.fields,
    entities: S.Array(
      S.Struct({
        ref: S.String,
        kind: S.Literals(["issue", "pull"]),
        state: S.String,
        title: S.String,
        worktree: S.optionalKey(S.String),
      }),
    ),
    agents: S.Array(
      S.Struct({
        key: S.String,
        kind: S.String,
        brief: S.String,
        state: S.Literals(["running", "done", "failed", "stopped"]),
      }),
    ),
    members: S.Array(S.String),
  }),
)`
  One thread's full state: its entities (the GitHub issues and pulls it
  governs), its subagents, and the channel message ids placed on it
  (members).`;

const Thread = AI.Thing("thread", ThreadRow)`
  A thread: id, name, title, status, whose turn.`;

const issueState = AI.Thing("state", S.Literals(["open", "closed"]))`
  The entity's state as GitHub reports it.`;

const body = AI.Thing("body", S.String)`
  The entity's body, markdown, verbatim.`;

const author = AI.Thing("author", S.UndefinedOr(S.String))`
  The GitHub login that authored the entity.`;

const merged = AI.Thing("merged", S.Boolean)`
  Whether the pull request has been merged.`;

const head = AI.Thing("head", S.UndefinedOr(S.String))`
  The pull request's head branch.`;

const base = AI.Thing("base", S.UndefinedOr(S.String))`
  The pull request's base branch.`;

/* ── declared failures ──────────────────────────────────────────── */

class UnknownRepo extends Data.TaggedError("UnknownRepo")<{
  message: string;
}> {}
class NotFound extends Data.TaggedError("NotFound")<{ message: string }> {}

/** `main@<seq>` — the run's pin rides in its session key. */
export const channelRunKey = (seq: number): string => `main@${seq}`;

const pinnedOf = (key: string): number => {
  const seq = Number(key.split("@")[1]);
  return Number.isFinite(seq) ? seq : Number.MAX_SAFE_INTEGER;
};

const charter = Effect.gen(function* () {
  // ── INIT: once per run (a run is one operator message) ───────────
  const channel = yield* Channel;
  const threads = yield* Threads;
  const threadAgent = yield* ThreadAgent;
  const thread = yield* AI.Thread;
  const pinned = pinnedOf(thread.key);

  // one GitHub read client per connected repository
  const repos = yield* Effect.forEach(connected, (entry) =>
    Effect.gen(function* () {
      const identity = yield* GitHub.resolveRepository(entry.repository);
      return {
        full: `${identity.owner}/${identity.repository}`,
        getIssue: yield* GitHub.GetIssue(entry.repository),
        getPullRequest: yield* GitHub.GetPullRequest(entry.repository),
      };
    }),
  );

  const repoOf = (full: string) =>
    Effect.gen(function* () {
      const found = repos.find((r) => r.full === full);
      return (
        found ??
        (yield* Effect.fail(
          new UnknownRepo({
            message: `${full} is not a connected repository (${repos
              .map((r) => r.full)
              .join(", ")})`,
          }),
        ))
      );
    });

  const searchMessages = yield* AI.Tool("search_messages")`
    Search the channel for messages matching ${q} — newest first, at
    most ${limit}, clamped to what existed when your message was
    sent. Answers ${AI.out(hits)}.`(
    Effect.fn(function* (p: { q: string; limit?: number }) {
      return {
        hits: yield* channel.search({
          q: p.q,
          before: pinned,
          limit: p.limit,
        }),
      };
    }),
  );

  const readHistory = yield* AI.Tool("read_history")`
    Read the channel BACKWARDS from your pin — answers the most
    recent ${AI.out(messages)} at or before your own. Use ${before}
    to page further back, ${limit} to size the page.`(
    Effect.fn(function* (p: { before?: number; limit?: number }) {
      const upTo = Math.min(p.before ?? pinned, pinned);
      const size = Math.min(p.limit ?? 50, 200);
      const page = yield* channel.page({
        after: Math.max(0, upTo - size),
        limit: size,
      });
      return { messages: page.items };
    }),
  );

  const readMessages = yield* AI.Tool("read_messages")`
    Read the messages named by ${ids} — answers ${AI.out(messages)},
    full rows in that order, clamped to your pin.`(
    Effect.fn(function* (p: { ids: ReadonlyArray<string> }) {
      const rows = yield* channel.read(p.ids);
      return { messages: rows.filter((row) => row.seq <= pinned) };
    }),
  );

  const listThreads = yield* AI.Tool("list_threads")`
    The org's thread directory — answers ${AI.out(threadRows)}.`(
    Effect.fn(function* () {
      return { threads: yield* channel.directory() };
    }),
  );

  const readThread = yield* AI.Tool("read_thread")`
    Read thread ${threadId} — answers its full ${AI.out(state)}.
    Fails with ${NotFound} for an id the directory does not know.`(
    Effect.fn(function* (p: { thread: string }) {
      const found = yield* threads.get(p.thread);
      if (found === undefined) {
        return yield* Effect.fail(
          new NotFound({ message: `no thread ${p.thread}` }),
        );
      }
      return { state: found };
    }),
  );

  const createThread = yield* AI.Tool("create_thread")`
    Create a thread — a task with its own agent, sandbox, and
    conversation: ${name}, ${title}. Answers the ${AI.out(Thread)}.
    Then place messages, attach entities, and brief its agent.`(
    Effect.fn(function* (p: { name: string; title: string }) {
      const thread = yield* threads.create({
        id: mintThreadId(p.name),
        name: p.name,
        title: p.title,
      });
      return { thread };
    }),
  );

  const placeMessages = yield* AI.Tool("place_messages")`
    Place channel messages ${ids} into ${threadId} — retroactive
    curation: the rows stay in the channel, tagged; the thread's view
    shows them. Idempotent.`(
    Effect.fn(function* (p: { thread: string; ids: ReadonlyArray<string> }) {
      yield* threads.place(p.thread, p.ids);
    }),
  );

  // an attach is VERIFIED against GitHub, never taken on the model's word
  const lookup = yield* makeEntityLookup;

  const attachEntity = yield* AI.Tool("attach_entity")`
    Attach entity ${ref} to ${threadId} — the thread governs it from
    now on: its events route there. The ref is looked up on GitHub;
    answers ${AI.out(kind, entityTitle)} as GitHub has them. Fails
    with ${BadRef} when the ref is not "owner/repo#N", names a
    repository that is not connected, or does not exist — copy refs
    from the channel's links, never derive them from an author's
    login.`(
    Effect.fn(function* (p: { thread: string; ref: string }) {
      const entity = yield* lookup(p.ref);
      yield* threads.attach(p.thread, [entity]);
      return { kind: entity.kind, title: entity.title };
    }),
  );

  const detachEntity = yield* AI.Tool("detach_entity")`
    Detach ${ref} from ${threadId}.`(
    Effect.fn(function* (p: { thread: string; ref: string }) {
      yield* threads.detach(p.thread, p.ref);
    }),
  );

  const briefThread = yield* AI.Tool("brief_thread")`
    Send ${text} to ${threadId}'s agent — the brief that starts its
    work, a steer, the operator's instruction relayed. Fire and
    forget; its work shows up in the thread.`(
    Effect.fn(function* (p: { thread: string; text: string }) {
      yield* threadAgent.send(p.text, { key: p.thread });
    }),
  );

  const renameThread = yield* AI.Tool("rename_thread")`
    Rename ${threadId}: a new ${title} (and optionally a new name)
    when the old one misnames the work.`(
    Effect.fn(function* (p: { thread: string; title: string; name?: string }) {
      yield* threads.rename(p.thread, {
        title: p.title,
        ...(p.name === undefined ? {} : { name: p.name }),
      });
    }),
  );

  const closeThread = yield* AI.Tool("close_thread")`
    Close ${threadId} — bookkeeping only; make sure its work already
    landed on GitHub.`(
    Effect.fn(function* (p: { thread: string }) {
      yield* threads.close(p.thread);
    }),
  );

  const readIssue = yield* AI.Tool("read_issue")`
    Read ${repo}'s issue ${number} fresh from GitHub —
    answers with ${AI.out(entityTitle, issueState, body, author)}. 
    Fails with ${UnknownRepo} for a repository the org is not connected to,
    ${NotFound} when the issue does not exist.`(
    Effect.fn(function* (p: { repo: string; number: number }) {
      const client = yield* repoOf(p.repo);
      const issue = yield* client
        .getIssue({ issue_number: p.number })
        .pipe(
          Effect.mapError((error) => new NotFound({ message: String(error) })),
        );
      return {
        title: issue.title,
        state:
          issue.state === "closed" ? ("closed" as const) : ("open" as const),
        body: issue.body ?? "",
        author: issue.user?.login,
      };
    }),
  );

  const readPull = yield* AI.Tool("read_pull")`
    Read ${repo}'s pull request ${number} fresh from GitHub — answers
    ${AI.out(entityTitle, issueState, merged, head, base, body, author)}.
    Fails with ${UnknownRepo} for a repository the org is not
    connected to, ${NotFound} when it does not exist.`(
    Effect.fn(function* (p: { repo: string; number: number }) {
      const client = yield* repoOf(p.repo);
      const pull = yield* client
        .getPullRequest({ pull_number: p.number })
        .pipe(
          Effect.mapError((error) => new NotFound({ message: String(error) })),
        );
      return {
        title: pull.title,
        state:
          pull.state === "closed" ? ("closed" as const) : ("open" as const),
        merged: pull.merged === true,
        head: pull.head?.ref,
        base: pull.base?.ref,
        body: pull.body ?? "",
        author: pull.user?.login,
      };
    }),
  );

  const sendReply = yield* AI.Tool("send_reply")`
    Answer the operator in the channel with ${text} — your ONE
    user-visible output. Call it exactly once per run, last.`(
    Effect.fn(function* (p: { text: string }) {
      yield* channel.append({
        kind: "agent",
        text: p.text,
      });
    }),
  );

  // ── the STANCE: STATIC — never splice mutable state (the thread
  // directory, counts, clocks) into it: a stance that changes between
  // samplings busts the provider's prompt cache on every call. The
  // pin is per-session constant; ${listThreads} answers the directory.
  return AI.fragment`
    You are the org's CHANNEL — the operator's single point of
    control over their GitHub repositories. You run with ZERO
    standing context: this session serves exactly one operator
    message, pinned at seq ${String(pinned)}; regain whatever you
    need by reading BACKWARDS (${readHistory}, ${searchMessages},
    ${readMessages}) — nothing after your pin exists for you.

    You are a router and librarian, never a worker. Work belongs to
    THREADS: ${listThreads} is the directory — read it before you
    route. ${createThread} makes one, ${placeMessages} curates
    channel messages into it (retroactively — that is normal),
    ${attachEntity} gives it the GitHub entities it governs, and
    ${briefThread} starts or steers its agent. Read the world with
    ${readThread}, ${readIssue}, ${readPull}. Reshape with
    ${renameThread}, ${detachEntity}, ${closeThread}.

    Every run ENDS with exactly one ${sendReply} — short, factual,
    what you did and where it lives. If the ask is ambiguous, reply
    with the question instead of guessing.`;
});

/**
 * The channel agent over CODEMODE: tools are importable functions, a
 * tick is one eval in a fresh isolate (`worker_loader`).
 */
export const ChannelAgentLive = ChannelAgent.make(charter).pipe(
  Layer.provide(AI.CodeModeAsync()),
  Layer.provide(Cloudflare.AI.EvalWorkerLoader()),
);
