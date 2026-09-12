import * as AI from "alchemy/AI";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import { BadRef, makeEntityLookup } from "../github/Entity.ts";
import { connected } from "../github/Repos.ts";
import { models } from "../platform/Model.ts";
import { Registry } from "../registry/Registry.ts";
import { makeSyncGitHub } from "../registry/Sync.ts";
import { mintThreadId, Threads } from "../thread/Threads.ts";
import { Channel } from "./Channel.ts";

/**
 * The CHANNEL AGENT — ONE persistent codemode session (`Channel:main`)
 * for the whole org, the operator's chief of staff. Its problem is
 * volume: more issues and pull requests than one human can track. Its
 * memory is the REGISTRY — a durable database of entity snapshots,
 * groups, relations, and tasks — not the event stream and not its own
 * transcript: it syncs GitHub into the Registry, organizes there
 * (pure bookkeeping, no side effects), DISPATCHES tasks to threads as
 * a separate explicit act, tracks those task forces, and surfaces
 * everything needing the human into the one channel conversation.
 *
 * It never writes to the outside world. External acts — commenting,
 * merging, closing — are PROPOSED: staged in the Registry and
 * surfaced as approval cards the operator decides in the channel.
 *
 * CODEMODE: its tools are presented as importable functions and a
 * tick is one `eval` of the module the model writes
 * (`AI.CodeModeAsync` over the isolate loader), so a sweep like
 * "sync, group the S3 fixes, and make tasks per group" is one
 * program, not thirty tool calls.
 */
export class ChannelAgent extends AI.Agent<ChannelAgent>(import.meta)(
  "Channel",
) {}

/* ── vocabulary: the ontology the tools are expressions over ────── */

const threadId = AI.Thing("thread", S.String)`
  A thread id (t-…).`;

const name = AI.Thing("name", S.String)`
  The thread's short handle for the rail — lowercase, hyphenated,
  2-4 words, and CONTEXTUAL: it names the substance of the work as
  you found it by reading, not the surface of one reference.`;

const title = AI.Thing("title", S.String)`
  One line — what it is about, in plain words.`;

const text = AI.Thing("text", S.String)`
  The text, complete and self-contained. Markdown.`;

const ref = AI.Thing("ref", S.String)`
  A GitHub issue or pull request, fully qualified — "owner/repo#832".`;

const refs = AI.Thing("refs", S.Array(S.String))`
  GitHub refs, each fully qualified ("owner/repo#N").`;

const kind = AI.Thing("kind", S.Literals(["issue", "pull"]))`
  What the ref is.`;

const entityTitle = AI.Thing("title", S.String)`
  Its title, as GitHub has it.`;

const repo = AI.Thing("repo", S.String)`
  The repository, "owner/repo".`;

const number = AI.Thing("number", S.Int)`
  An issue or pull request number.`;

/** One Registry entity snapshot, as query_entities answers it. */
const Entity = S.Struct({
  ref: S.String,
  kind: S.Literals(["issue", "pull"]),
  state: S.Literals(["open", "closed", "merged", "draft"]),
  title: S.String,
  author: S.optionalKey(S.String),
  labels: S.Array(S.String),
  headRef: S.optionalKey(S.String),
  baseRef: S.optionalKey(S.String),
  updatedAt: S.Number,
});

const entities = AI.Thing("entities", S.Array(Entity))`
  Registry snapshots of GitHub entities, most recently updated first.`;

const entityFilter = AI.Thing(
  "filter",
  S.Struct({
    kind: S.optionalKey(S.Literals(["issue", "pull"])),
    state: S.optionalKey(S.Literals(["open", "closed", "merged", "draft"])),
    label: S.optionalKey(S.String),
    group: S.optionalKey(S.String),
    unorganized: S.optionalKey(S.Boolean),
    q: S.optionalKey(S.String),
    limit: S.optionalKey(S.Int),
  }),
)`
  What to select: by kind, state, label, group (id or name),
  unorganized (in NO group and NO task — the triage tray), or a
  substring over ref+title.`;

const groupName = AI.Thing("group", S.String)`
  A group, by id (g-…) or by its unique name.`;

const purpose = AI.Thing("purpose", S.optionalKey(S.String))`
  Why the group exists — one line.`;

const Group = S.Struct({
  id: S.String,
  name: S.String,
  purpose: S.optionalKey(S.String),
  refs: S.Array(S.String),
});

const group = AI.Thing("group", Group)`
  The group: id, name, purpose, member refs.`;

const relationKind = AI.Thing(
  "kind",
  S.Literals(["fixes", "duplicates", "depends_on", "relates_to", "supersedes"]),
)`
  How src relates to dst.`;

const src = AI.Thing("src", S.String)`
  The relation's source ref ("owner/repo#N").`;

const dst = AI.Thing("dst", S.String)`
  The relation's destination ref ("owner/repo#N").`;

const note = AI.Thing("note", S.optionalKey(S.String))`
  Why — one line, optional.`;

const taskId = AI.Thing("task", S.String)`
  A task id (task-…).`;

const taskGroup = AI.Thing("group", S.optionalKey(S.String))`
  The group (id or name) the task belongs to, optional.`;

const optStatus = AI.Thing(
  "status",
  S.optionalKey(S.Literals(["todo", "dispatched", "in_review", "blocked", "done"])),
)`
  Move the task to this kanban column, optional.`;

const optTitle = AI.Thing("title", S.optionalKey(S.String))`
  A new title, optional.`;

const optRefs = AI.Thing("refs", S.optionalKey(S.Array(S.String)))`
  Replacement refs (the full new set), optional.`;

const Task = S.Struct({
  id: S.String,
  title: S.String,
  status: S.Literals(["todo", "dispatched", "in_review", "blocked", "done"]),
  groupId: S.optionalKey(S.String),
  threadId: S.optionalKey(S.String),
  note: S.optionalKey(S.String),
  refs: S.Array(S.String),
});

const task = AI.Thing("task", Task)`
  The task: id, title, status, refs, its group and thread when linked.`;

const tasks = AI.Thing("tasks", S.Array(Task))`
  Tasks, most recently updated first.`;

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
  One thread's full state: what is assigned to it, its subagents, and
  the channel message ids placed on it (members).`;

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
  The files the pull request changes (first 100): path, status,
  +/− line counts. The paths are what a pull is ABOUT.`;

const synced = AI.Thing(
  "synced",
  S.Struct({ pulls: S.Int, issues: S.Int, closedOut: S.Int }),
)`
  What the sweep reconciled: open pulls, open issues, and rows GitHub
  no longer lists as open (flipped closed in the Registry).`;

const approvalId = AI.Thing("approval", S.String)`
  The staged approval's id (appr-…) — the operator decides it on the
  card in the channel.`;

const gatedFlag = AI.Thing("gated", S.Boolean)`
  true = the kind stages an approval; false = it acts directly.`;

const policyKind = AI.Thing(
  "kind",
  S.Literals(["comment", "push", "open_pull", "merge", "close"]),
)`
  The action kind the policy governs.`;

const reason = AI.Thing("reason", S.optionalKey(S.String))`
  Why — one line, optional.`;

/* ── declared failures ──────────────────────────────────────────── */

class UnknownRepo extends Data.TaggedError("UnknownRepo")<{
  message: string;
}> {}
class NotFound extends Data.TaggedError("NotFound")<{ message: string }> {}
class SyncFailed extends Data.TaggedError("SyncFailed")<{ message: string }> {}

/** The one persistent session's key — `Channel:main`. */
export const CHANNEL_SESSION_KEY = "main";

/**
 * The channel agent over CODEMODE: tools are importable functions, a
 * tick is one eval in a fresh isolate (`worker_loader`).
 */
export const ChannelAgentLive = ChannelAgent.make(
  Effect.gen(function* () {
    const channel = yield* Channel;
    const threads = yield* Threads;
    const registry = yield* Registry;
    const syncGitHub = yield* makeSyncGitHub;
    // the operator's model pick lives on the channel; read as the
    // stance is provided, so a pick governs the next sampling
    const getModel = yield* models;

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

    /* ── GitHub: sync + fresh reads ─────────────────────────────── */

    const syncTool = yield* AI.Tool("sync_github")`
      Reconcile the Registry with GitHub: every open pull and issue of
      the connected repositories is upserted, rows GitHub no longer
      lists as open are closed out. Answers ${AI.out(synced)}; fails
      with ${SyncFailed} when GitHub does. Run it when the operator
      asks for a sweep, when the Registry looks stale, and before
      organizing work you have not looked at recently — queries read
      the Registry, and the Registry only knows what was synced.`(
      Effect.fn(function* () {
        return {
          synced: yield* syncGitHub().pipe(
            Effect.mapError(
              (error) => new SyncFailed({ message: String(error) }),
            ),
          ),
        };
      }),
    );

    const queryEntities = yield* AI.Tool("query_entities")`
      Query the Registry's entity snapshots by ${entityFilter} —
      answers ${AI.out(entities)}. This is YOUR view of GitHub: cheap,
      local, as fresh as the last sync. \`unorganized: true\` is the
      triage tray — everything not yet in any group or task.`(
      Effect.fn(function* (p: {
        filter: {
          kind?: "issue" | "pull";
          state?: "open" | "closed" | "merged" | "draft";
          label?: string;
          group?: string;
          unorganized?: boolean;
          q?: string;
          limit?: number;
        };
      }) {
        return { entities: yield* registry.queryEntities(p.filter) };
      }),
    );

    const readIssue = yield* AI.Tool("read_issue")`
      Read ${repo}'s issue ${number} fresh from GitHub —
      answers with ${AI.out(entityTitle, issueState, body, author)}.
      Fails with ${UnknownRepo} for a repository the org is not
      connected to, ${NotFound} when the issue does not exist.`(
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

    /* ── organize: pure Registry writes, NO side effects ────────── */

    const createGroup = yield* AI.Tool("create_group")`
      Create a group named ${name} (${purpose}), optionally seeded
      with ${refs} — answers the ${AI.out(group)}. Groups are pure
      organization: nothing on GitHub or in any thread changes.
      Idempotent on the name.`(
      Effect.fn(function* (p: {
        name: string;
        purpose?: string;
        refs?: ReadonlyArray<string>;
      }) {
        return { group: yield* registry.createGroup(p) };
      }),
    );

    const addToGroup = yield* AI.Tool("add_to_group")`
      Add ${refs} to ${groupName} — answers the ${AI.out(group)}.
      Fails with ${NotFound} for a group the Registry does not know.`(
      Effect.fn(function* (p: { group: string; refs: ReadonlyArray<string> }) {
        const next = yield* registry.addToGroup(p.group, p.refs);
        if (next === undefined) {
          return yield* Effect.fail(
            new NotFound({ message: `no group ${p.group}` }),
          );
        }
        return { group: next };
      }),
    );

    const removeFromGroup = yield* AI.Tool("remove_from_group")`
      Remove ${refs} from ${groupName} — answers the ${AI.out(group)}.
      Fails with ${NotFound} for a group the Registry does not know.`(
      Effect.fn(function* (p: { group: string; refs: ReadonlyArray<string> }) {
        const next = yield* registry.removeFromGroup(p.group, p.refs);
        if (next === undefined) {
          return yield* Effect.fail(
            new NotFound({ message: `no group ${p.group}` }),
          );
        }
        return { group: next };
      }),
    );

    const relate = yield* AI.Tool("relate")`
      Record that ${src} ${relationKind} ${dst} (${note}) — a typed
      edge in the Registry, how cross-references are remembered
      ("fixes #830" in a pull's body becomes pull fixes issue).
      Idempotent.`(
      Effect.fn(function* (p: {
        src: string;
        kind: "fixes" | "duplicates" | "depends_on" | "relates_to" | "supersedes";
        dst: string;
        note?: string;
      }) {
        yield* registry.relate(p);
      }),
    );

    const createTask = yield* AI.Tool("create_task")`
      Create a task titled ${title} covering ${refs} (optionally in
      ${taskGroup}, with ${note}) — answers the ${AI.out(task)}. A
      task is a unit of dispatchable work on the board; creating one
      dispatches NOTHING.`(
      Effect.fn(function* (p: {
        title: string;
        refs?: ReadonlyArray<string>;
        group?: string;
        note?: string;
      }) {
        return {
          task: yield* registry.createTask({
            title: p.title,
            ...(p.refs === undefined ? {} : { refs: p.refs }),
            ...(p.group === undefined ? {} : { groupId: p.group }),
            ...(p.note === undefined ? {} : { note: p.note }),
          }),
        };
      }),
    );

    const updateTask = yield* AI.Tool("update_task")`
      Update ${taskId}: ${optStatus}, a new ${optTitle}, ${note}, or
      replacement ${optRefs}. Answers the ${AI.out(task)}. Fails with
      ${NotFound} for an unknown task.`(
      Effect.fn(function* (p: {
        task: string;
        status?: "todo" | "dispatched" | "in_review" | "blocked" | "done";
        title?: string;
        note?: string;
        refs?: ReadonlyArray<string>;
      }) {
        const next = yield* registry.updateTask(p.task, p);
        if (next === undefined) {
          return yield* Effect.fail(
            new NotFound({ message: `no task ${p.task}` }),
          );
        }
        return { task: next };
      }),
    );

    const listTasks = yield* AI.Tool("list_tasks")`
      The board's tasks — answers ${AI.out(tasks)}.`(
      Effect.fn(function* () {
        const board = yield* registry.board();
        return { tasks: board.tasks };
      }),
    );

    /* ── dispatch: the explicit, separate act ───────────────────── */

    // an assignment is VERIFIED against GitHub, never taken on the
    // model's word
    const lookup = yield* makeEntityLookup;

    const dispatchTask = yield* AI.Tool("dispatch_task")`
      DISPATCH ${taskId}: create a thread (${name}, ${title}), assign
      the task's refs to it (each verified against GitHub), brief its
      agent with ${text}, and link the thread back onto the task
      (status becomes dispatched). Answers the ${AI.out(Thread)}.
      Fails with ${NotFound} for an unknown task, ${BadRef} when a
      ref does not resolve on GitHub. Dispatch is the ONLY way
      organizing turns into work — never dispatch what the operator
      has not asked (or agreed) to start.`(
      Effect.fn(function* (p: {
        task: string;
        name: string;
        title: string;
        text: string;
      }) {
        const found = yield* registry
          .board()
          .pipe(
            Effect.map((board) =>
              board.tasks.find((entry) => entry.id === p.task),
            ),
          );
        if (found === undefined) {
          return yield* Effect.fail(
            new NotFound({ message: `no task ${p.task}` }),
          );
        }
        const thread = yield* threads.create({
          id: mintThreadId(p.name),
          name: p.name,
          title: p.title,
        });
        for (const taskRef of found.refs) {
          const entity = yield* lookup(taskRef);
          yield* threads.assign(thread.id, [entity]);
        }
        yield* threads.brief(thread.id, p.text);
        yield* registry.linkThread(p.task, thread.id);
        return {
          thread: {
            id: thread.id,
            name: thread.name,
            title: thread.title,
            status: thread.status,
            turn: thread.turn,
          },
        };
      }),
    );

    /* ── threads: the task forces ───────────────────────────────── */

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

    const assign = yield* AI.Tool("assign")`
      Assign ${ref} to ${threadId} — the thread governs it from now
      on. The ref is looked up on GitHub; answers
      ${AI.out(kind, entityTitle)} as GitHub has them. Fails with
      ${BadRef} when the ref is not "owner/repo#N", names a repository
      that is not connected, or does not exist.`(
      Effect.fn(function* (p: { thread: string; ref: string }) {
        const entity = yield* lookup(p.ref);
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
      Send ${text} to ${threadId}'s agent — a steer, the operator's
      instruction relayed, or your follow-up on its progress. Name
      every issue and pull request fully qualified ("owner/repo#832"),
      never a bare "#832". Fire and forget.`(
      Effect.fn(function* (p: { thread: string; text: string }) {
        yield* threads.brief(p.thread, p.text);
      }),
    );

    const closeThread = yield* AI.Tool("close_thread")`
      Close ${threadId} — bookkeeping only; make sure its work already
      landed on GitHub. Move its task to done first (update_task).`(
      Effect.fn(function* (p: { thread: string }) {
        yield* threads.close(p.thread);
      }),
    );

    /* ── proposals: external writes, staged for the human ───────── */

    const proposeComment = yield* AI.Tool("propose_comment")`
      PROPOSE commenting on ${ref} with ${body} — stages an approval
      card in the channel; nothing lands on GitHub until the operator
      approves it there. Answers ${AI.out(approvalId)}.`(
      Effect.fn(function* (p: { ref: string; body: string }) {
        const approval = yield* registry.stageApproval({
          kind: "comment",
          summary: `comment on ${p.ref}`,
          payload: { kind: "comment", ref: p.ref, body: p.body },
          stager: { term: "Channel", key: CHANNEL_SESSION_KEY },
        });
        const card = yield* channel.append({
          kind: "card",
          text: p.body,
          card: {
            title: `Approve: comment on ${p.ref}`,
            approval: { id: approval.id, kind: "comment" },
          },
        });
        yield* registry.attachApprovalCard(approval.id, card.id);
        return { approval: approval.id };
      }),
    );

    const proposeMerge = yield* AI.Tool("propose_merge")`
      PROPOSE merging pull request ${ref} — stages an approval card;
      the merge happens only when the operator approves it. Answers
      ${AI.out(approvalId)}. Propose a merge only when the pull is
      green and reviewed, and say why in the card.`(
      Effect.fn(function* (p: { ref: string; reason?: string }) {
        const approval = yield* registry.stageApproval({
          kind: "merge",
          summary: `merge ${p.ref}`,
          payload: { kind: "merge", ref: p.ref },
          stager: { term: "Channel", key: CHANNEL_SESSION_KEY },
        });
        const card = yield* channel.append({
          kind: "card",
          text: p.reason ?? `Merge ${p.ref}.`,
          card: {
            title: `Approve: merge ${p.ref}`,
            approval: { id: approval.id, kind: "merge" },
          },
        });
        yield* registry.attachApprovalCard(approval.id, card.id);
        return { approval: approval.id };
      }),
    );

    const proposeClose = yield* AI.Tool("propose_close")`
      PROPOSE closing ${ref} (${reason}) — stages an approval card;
      the close happens only when the operator approves it. Answers
      ${AI.out(approvalId)}.`(
      Effect.fn(function* (p: { ref: string; reason?: string }) {
        const approval = yield* registry.stageApproval({
          kind: "close",
          summary: `close ${p.ref}`,
          payload: { kind: "close", ref: p.ref, ...(p.reason === undefined ? {} : { reason: p.reason }) },
          stager: { term: "Channel", key: CHANNEL_SESSION_KEY },
        });
        const card = yield* channel.append({
          kind: "card",
          text: p.reason ?? `Close ${p.ref}.`,
          card: {
            title: `Approve: close ${p.ref}`,
            approval: { id: approval.id, kind: "close" },
          },
        });
        yield* registry.attachApprovalCard(approval.id, card.id);
        return { approval: approval.id };
      }),
    );

    const setPolicy = yield* AI.Tool("set_policy")`
      Set the gate for ${policyKind} to ${gatedFlag} — the policy
      governing whether that action kind stages an approval (true) or
      acts directly (false). Change it ONLY when the operator says so,
      and repeat back what you changed.`(
      Effect.fn(function* (p: {
        kind: "comment" | "push" | "open_pull" | "merge" | "close";
        gated: boolean;
      }) {
        yield* registry.setPolicy(p.kind, p.gated);
      }),
    );

    const sendReply = yield* AI.Tool("send_reply")`
      Answer the operator in the channel with ${text} — your ONE
      user-visible output. Call it exactly once per round, last.`(
      Effect.fn(function* (p: { text: string }) {
        yield* channel.append({
          kind: "agent",
          text: p.text,
        });
      }),
    );

    // ── the STANCE: STATIC — never splice mutable state (counts,
    // clocks, directories) into it: a stance that changes between
    // samplings busts the provider's prompt cache on every call.
    return AI.fragment`
      You are the org's CHANNEL AGENT — one persistent session, the
      operator's chief of staff over their GitHub repositories. The
      operator's problem is VOLUME: more issues and pull requests than
      one person can track. Your job: keep the whole picture organized
      in the REGISTRY, dispatch task forces, track them, and surface
      exactly what needs the human — so the operator never has to
      leave this conversation.

      THE REGISTRY IS YOUR MEMORY, not your transcript and not the
      event stream. ${syncTool} reconciles it with GitHub (GitHub is
      the source of truth for entities; sync before organizing
      anything you have not looked at recently). ${queryEntities} is
      how you see: filters over the snapshots, including the triage
      tray (unorganized: true) of everything not yet organized. For
      depth on one entity, read it fresh: ${readIssue}, ${readPull}.

      ORGANIZE in the Registry — ${createGroup}, ${addToGroup},
      ${removeFromGroup}, ${relate}, ${createTask}, ${updateTask},
      ${listTasks}. Organizing is pure bookkeeping: it never touches
      GitHub, never starts work, and the operator sees it on the
      board. Do it continuously and confidently — this is how you keep
      up with the volume on the operator's behalf.

      DISPATCH is the separate, explicit act: ${dispatchTask} turns
      ONE task into ONE thread (a task force with its own agent,
      machine, and conversation) and links them. Never dispatch work
      the operator has not asked for or agreed to. Steer and track
      the forces with ${listThreads}, ${readThread}, ${briefThread},
      ${assign}, ${unassign}, ${closeThread}. Their questions arrive
      in your context as [card] notes — relay what matters to the
      operator, answer what you can yourself.

      YOU NEVER WRITE TO THE OUTSIDE WORLD. Commenting on GitHub,
      merging, closing — you PROPOSE (${proposeComment},
      ${proposeMerge}, ${proposeClose}): each stages an approval card
      in this channel that the operator decides. The decision comes
      back to you as a note; act on the outcome. ${setPolicy} loosens
      or tightens the gates, only on the operator's word.

      Every round that the operator's message started ENDS with
      exactly one ${sendReply} — short, factual, what you did and
      what needs them. Name every issue and pull request as a full
      markdown link to its GitHub URL
      ("[owner/repo#832](https://github.com/owner/repo/pull/832)" —
      /issues/ for issues), never a bare "#832". If the ask is
      ambiguous, reply with the question instead of guessing.

      Your transcript grows forever; the Registry does not forget.
      After a large sweep, prefer compacting your own context over
      re-reading it — anything worth remembering belongs in the
      Registry, not in the transcript.`.pipe(
      Effect.provide(
        // suspended: the facade resolves the DO stub as the call is
        // made, and the charter runs at plan time where no binding exists
        Layer.unwrap(
          Effect.map(
            Effect.suspend(() => channel.model()),
            (pick) => getModel(pick),
          ),
        ),
      ),
    );
  }),
).pipe(
  Layer.provide(AI.CodeModeAsync()),
  Layer.provide(Cloudflare.AI.EvalWorkerLoader()),
);
