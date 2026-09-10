import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { BadRef, makeEntityLookup } from "../github/Entity.ts";
import { connected } from "../github/Repos.ts";
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
 * channel, creates and shapes threads (place messages, assign
 * issues and pulls, brief the thread's agent), and answers the operator. The
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
  2-4 words, and CONTEXTUAL: it names the substance of the work as
  you found it by reading, not the surface of one reference. Five
  pulls whose commit prefix says "fix(cloudflare)" but whose bodies
  are all about container images are "container-image-fixes", not
  "cloudflare-fixes"; one issue about a Durable Object hanging on
  init is "do-init-hang". Never a generic bucket ("misc-fixes",
  "pr-review"), never an author's login, never a bare number.`;

const title = AI.Thing("title", S.String)`
  One line — what the task is about, in plain words, specific enough
  that someone reading only the rail knows what the thread does.`;

const text = AI.Thing("text", S.String)`
  The text, complete and self-contained. Markdown.`;

const ref = AI.Thing("ref", S.String)`
  A GitHub issue or pull request, fully qualified — "owner/repo#832".`;

const kind = AI.Thing("kind", S.Literals(["issue", "pull"]))`
  What the ref is.`;

const entityTitle = AI.Thing("title", S.String)`
  Its title, as GitHub has it.`;

const repo = AI.Thing("repo", S.String)`
  The repository, "owner/repo".`;

const number = AI.Thing("number", S.Int)`
  An issue or pull request number.`;

const limit = AI.Thing("limit", S.optionalKey(S.Int))`
  Most rows to answer (default 50).`;

const before = AI.Thing("before", S.optionalKey(S.Int))`
  A message seq — only rows at or before it.`;

/** One channel message, as every reading tool answers it. */
const Message = S.Struct({
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

const hits = AI.Thing("hits", S.Array(Message))`
  The matching channel messages, newest first.`;

const messages = AI.Thing("messages", S.Array(Message))`
  Channel messages, oldest first.`;

/** A thread, as the directory and the state tools answer it. */
const ThreadSummary = S.Struct({
  id: S.String,
  name: S.String,
  title: S.String,
  status: S.Literals(["open", "closed"]),
  turn: S.Literals(["you", "agents", "others", "idle"]),
});

const threadSummaries = AI.Thing("threads", S.Array(ThreadSummary))`
  Every thread in the org: id, name, title, status, whose turn.`;

const state = AI.Thing(
  "state",
  S.Struct({
    ...ThreadSummary.fields,
    assigned: S.Array(
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
  One thread's full state: what is assigned to it (the GitHub issues
  and pulls it governs), its subagents, and the channel message ids placed on it
  (members).`;

const Thread = AI.Thing("thread", ThreadSummary)`
  A thread: id, name, title, status, whose turn.`;

const issueState = AI.Thing("state", S.Literals(["open", "closed"]))`
  Its state as GitHub reports it.`;

const body = AI.Thing("body", S.String)`
  Its body, markdown, verbatim.`;

const author = AI.Thing("author", S.UndefinedOr(S.String))`
  The GitHub login that authored it.`;

const merged = AI.Thing("merged", S.Boolean)`
  Whether the pull request has been merged.`;

const head = AI.Thing("head", S.UndefinedOr(S.String))`
  The pull request's head branch.`;

const base = AI.Thing("base", S.UndefinedOr(S.String))`
  The pull request's base branch.`;

const files = AI.Thing(
  "files",
  S.Array(
    S.Struct({
      path: S.String,
      status: S.String,
      additions: S.Int,
      deletions: S.Int,
    }),
  ),
)`
  The files the pull request changes (first 100): path, status
  (added/modified/removed/renamed), +/− line counts. The paths are
  what a pull is ABOUT — read them before you name its thread.`;

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

/**
 * The channel agent over CODEMODE: tools are importable functions, a
 * tick is one eval in a fresh isolate (`worker_loader`).
 */
export const ChannelAgentLive = ChannelAgent.make(
  Effect.gen(function* () {
    const channel = yield* Channel;
    const threads = yield* Threads;
    // the run's PIN rides in its session key (`main@<seq>`) — read from
    // the frame by the tool or turn that needs it; the charter itself
    // runs once at build, for every run
    const pinned = Effect.map(AI.Thread, (thread) => pinnedOf(thread.key));

    // one GitHub read client per connected repository
    const repos = yield* Effect.forEach(
      connected,
      Effect.fn(function* (entry) {
        const identity = yield* GitHub.resolveRepository(entry.repository);
        return {
          full: `${identity.owner}/${identity.repository}`,
          getIssue: yield* GitHub.GetIssue(entry.repository),
          getPullRequest: yield* GitHub.GetPullRequest(entry.repository),
          listPullFiles: yield* GitHub.ListPullRequestFiles(entry.repository),
        };
      }),
    );

    const repoOf = Effect.fn(function* (full: string) {
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
            before: yield* pinned,
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
        const pin = yield* pinned;
        const upTo = Math.min(p.before ?? pin, pin);
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
        const pin = yield* pinned;
        const rows = yield* channel.read(p.ids);
        return { messages: rows.filter((row) => row.seq <= pin) };
      }),
    );

    const listThreads = yield* AI.Tool("list_threads")`
      The org's thread directory — answers ${AI.out(threadSummaries)}.`(
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
      Call it only AFTER you have read what the thread is about
      (read_pull / read_issue on every reference): the name and title
      come from what the work actually is, and you cannot know that
      from event one-liners. A thread is a shell until you fill it: in
      the same run, assign every issue and pull request it is about
      (assign), place the channel messages that led to it
      (place_messages), then brief its agent (brief_thread).`(
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
      shows them, and the thread's agent hears them as said (author,
      time, text) — place the operator's words rather than restating
      them in a brief. Idempotent.`(
      Effect.fn(function* (p: { thread: string; ids: ReadonlyArray<string> }) {
        yield* threads.place(p.thread, p.ids);
      }),
    );

    // an assignment is VERIFIED against GitHub, never taken on the model's word
    const lookup = yield* makeEntityLookup;

    const assign = yield* AI.Tool("assign")`
      Assign ${ref} to ${threadId} — the thread governs it from
      now on: its events route there. The ref is looked up on GitHub;
      answers ${AI.out(kind, entityTitle)} as GitHub has them. Fails
      with ${BadRef} when the ref is not "owner/repo#N", names a
      repository that is not connected, or does not exist — copy refs
      from the channel's links, never derive them from an author's login.`(
      Effect.fn(function* (p: { thread: string; ref: string }) {
        const entity = yield* lookup(p.ref);
        // the thread tells its agent (quietly — the brief that follows
        // wakes it, with the assignment already in its inbox)
        yield* threads.assign(p.thread, [entity]);
        return { kind: entity.kind, title: entity.title };
      }),
    );

    const unassign = yield* AI.Tool("unassign")`
      Unassign ${ref} from ${threadId}.`(
      Effect.fn(function* (p: { thread: string; ref: string }) {
        yield* threads.unassign(p.thread, p.ref);
      }),
    );

    const briefThread = yield* AI.Tool("brief_thread")`
      Send ${text} to ${threadId}'s agent — the brief that starts its
      work, a steer, the operator's instruction relayed. Name every
      issue and pull request in it fully qualified ("owner/repo#832", as
      assigned),
      never a bare "#832". Fire and forget; its work shows up in the
      thread.`(
      Effect.fn(function* (p: { thread: string; text: string }) {
        yield* threads.brief(p.thread, p.text);
      }),
    );

    const renameThread = yield* AI.Tool("rename_thread")`
      Rename ${threadId}: a new ${title} (and optionally a new name)
      when the old one misnames the work.`(
      Effect.fn(function* (p: {
        thread: string;
        title: string;
        name?: string;
      }) {
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
            Effect.mapError(
              (error) => new NotFound({ message: String(error) }),
            ),
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
      ${AI.out(entityTitle, issueState, merged, head, base, body, author, files)}.
      Fails with ${UnknownRepo} for a repository the org is not
      connected to, ${NotFound} when it does not exist.`(
      Effect.fn(function* (p: { repo: string; number: number }) {
        const client = yield* repoOf(p.repo);
        const notFound = (error: unknown) =>
          new NotFound({ message: String(error) });
        const [pull, changed] = yield* Effect.all(
          [
            client
              .getPullRequest({ pull_number: p.number })
              .pipe(Effect.mapError(notFound)),
            client
              .listPullFiles({ pull_number: p.number, per_page: 100 })
              .pipe(Effect.mapError(notFound)),
          ],
          { concurrency: 2 },
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
          files: changed.map((file) => ({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          })),
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

    // ── the STANCE: STATIC per run — never splice mutable state (the
    // thread directory, counts, clocks) into it: a stance that changes
    // between samplings busts the provider's prompt cache on every
    // call. The pin is the run's constant; ${listThreads} answers the
    // directory.
    return AI.fragment`
      You are the org's CHANNEL — the operator's single point of
      control over their GitHub repositories. You run with ZERO
      standing context: this session serves exactly one operator
      message, pinned at seq ${pinned}; regain whatever you
      need by reading BACKWARDS (${readHistory}, ${searchMessages},
      ${readMessages}) — nothing after your pin exists for you.

      You are a router and librarian, never a worker. Work belongs to
      THREADS: ${listThreads} is the directory — read it before you
      route. ${createThread} makes one, ${placeMessages} curates
      channel messages into it (retroactively — that is normal),
      ${assign} gives it the issues and pull requests it governs, and
      ${briefThread} starts or steers its agent. Read the world with
      ${readThread}, ${readIssue}, ${readPull}. Reshape with
      ${renameThread}, ${unassign}, ${closeThread}.

      READ BEFORE YOU ROUTE. A channel event is a one-liner — an
      author, a verb, a title; it is not the work. Before you name a
      thread, brief an agent, or answer a question about a pull or an
      issue, read every one the messages reference, fully, with
      ${readPull} / ${readIssue}: the body, the branches, the state,
      what it changes and why. Then read what THOSE reference — a pull
      that says "fixes #830" means #830 is part of the task too. In
      codemode this is one program: collect the refs, read them all,
      then decide. Only once you know what the set of changes is
      actually about do you choose a name and title — for the substance
      (five pulls all reworking container image publication are a
      container thread, whatever their commit prefixes say), never for
      a surface feature like a shared scope or an author. The brief you
      send carries that understanding: what each item is, how they
      relate, what the operator wants done with them.

      A thread is NOT DONE until its record is complete. Every issue or
      pull request the task concerns — the one the operator pointed at,
      the ones the messages you placed link to — is assigned with
      ${assign} before you reply; an unassigned issue or pull has no
      review tab, and its GitHub events route nowhere. Creating a thread
      without assigning what it is about is the single most common
      mistake — do not make it.

      Every run ENDS with exactly one ${sendReply} — short, factual,
      what you did and where it lives. Name every issue and pull request
      you mention as a full markdown link to its GitHub URL
      ("[owner/repo#832](https://github.com/owner/repo/pull/832)" —
      /issues/ for issues), never a bare "#832" or a plain ref: the
      channel renders those links with a hover card, and the operator
      follows them. Name the thread you created or steered by its id.
      If the ask is ambiguous, reply with the question instead of
      guessing.`;
  }),
).pipe(
  Layer.provide(AI.CodeModeAsync()),
  Layer.provide(Cloudflare.AI.EvalWorkerLoader()),
);
