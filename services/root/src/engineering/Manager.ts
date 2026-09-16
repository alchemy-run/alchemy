import * as AI from "alchemy/AI";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { Ask, Tell } from "../chat/Ask.ts";
import { Explore } from "../chat/Explore.ts";
import { Call } from "../chat/Call.ts";
import { Haiku } from "../platform/Model.ts";
import {
  proposeClose,
  proposeComment,
  proposeMerge,
} from "../proposals/Propose.ts";
import { dropWorkspace, workspace } from "../sandbox/WorkspaceTools.ts";
import { Tasks, type TaskItem, type TaskStatus } from "./Tasks.ts";

/**
 * The ENGINEERING MANAGER — the head of the engineering team, the
 * agent managing ITS thread the way the Head manages the Root: the
 * recursion IS the org.
 *
 * The inbound world arrives in ITS OWN SESSION INBOX (the session is
 * the queue — Triage.ts dedupes and pumps, the driver wakes); it files
 * each item into the TASK LEDGER (Tasks.ts), moves the
 * ledger todo → working → review → done, workspaces the work (one
 * workspace per task), verifies their output, and stages merge
 * proposals so the humans' approval is one click. It answers the Head
 * with short, factual reports — its answer IS the report.
 */
export class Manager extends AI.Agent<Manager>(import.meta)("Manager") {}

const taskId = AI.Thing("task", S.optionalKey(S.String))`
  An existing task's id — omit to create one.`;

const title = AI.Thing("title", S.optionalKey(S.String))`
  The task's one-line title.`;

const post = AI.Thing("post", S.optionalKey(S.String))`
  The thread's ROOT POST — your words, markdown. Filing IS posting:
  say what this is, why it matters, and what happens next, the way
  you'd post to the team. The item refs attach as pills — never paste
  raw URLs into the post. REQUIRED when creating.`;

/** Filing without a post is refused — a thread starts with words. */
export class PostRequired extends Data.TaggedError("PostRequired") {
  override get message(): string {
    return (
      "REFUSED: a new task is a POST — write `post` (markdown, your " +
      "words: what this is, why it matters, what happens next) and " +
      "file again. Item refs attach as pills; don't paste raw URLs."
    );
  }
}

const status = AI.Thing(
  "status",
  S.optionalKey(S.Literals(["todo", "working", "review", "done"])),
)`
  Where the work stands.`;

const assignee = AI.Thing("assignee", S.optionalKey(S.String))`
  The agent working it ("engineer").`;

const taskWorkspace = AI.Thing("workspace", S.optionalKey(S.String))`
  The workspace (by name) the work lives in.`;

const addItems = AI.Thing(
  "addItems",
  S.optionalKey(
    S.Array(
      S.Struct({
        ref: S.String,
        kind: S.Literals(["issue", "pull", "request"]),
      }),
    ),
  ),
)`
  Items joining the task — "owner/repo#N" refs (or a short label for a
  direct request) with their kind.`;

const removeItems = AI.Thing("removeItems", S.optionalKey(S.Array(S.String)))`
  Item refs leaving the task.`;

const taskNote = AI.Thing("note", S.optionalKey(S.String))`
  One line the ledger should remember.`;

const itemRef = AI.Thing("ref", S.String)`
  An item ref — "owner/repo#N".`;

const taskIdOut = AI.Thing("id", S.String)`
  The task's id — pass it back to task_upsert to update.`;

const covering = AI.Thing(
  "covering",
  S.NullOr(
    S.Struct({
      id: S.String,
      title: S.String,
      status: S.Literals(["todo", "working", "review", "done"]),
    }),
  ),
)`
  The covering task, or null when the ref is untracked.`;

const ledger = AI.Thing(
  "tasks",
  S.Array(
    S.Struct({
      id: S.String,
      title: S.String,
      status: S.Literals(["todo", "working", "review", "done"]),
      assignee: S.optionalKey(S.String),
      workspace: S.optionalKey(S.String),
      items: S.Array(
        S.Struct({
          ref: S.String,
          kind: S.Literals(["issue", "pull", "request"]),
        }),
      ),
    }),
  ),
)`
  The ledger's tasks, newest first.`;

const taskUpsert = AI.Tool("task_upsert")`
  Create or update a task — the unit of work, and a THREAD in the
  channel. Filing is POSTING: a new task REQUIRES ${post} (refused
  with ${PostRequired} otherwise). A task holds 1..* items (an
  issue, a PR, both — a late PR JOINS the issue's task, never
  forks a duplicate: check task_covering first). Move status
  todo → working → review → done as the work moves; record the
  assignee ("engineer") and the workspace when work starts; append a
  note for anything the ledger should remember: ${AI.in(
    taskId,
    title,
    status,
    assignee,
    taskWorkspace,
    addItems,
    removeItems,
    taskNote,
  )}. Answers ${AI.out(taskIdOut)}.`(
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    return Effect.fn(function* (p: {
      task?: string;
      title?: string;
      post?: string;
      status?: TaskStatus;
      assignee?: string;
      workspace?: string;
      addItems?: ReadonlyArray<TaskItem>;
      removeItems?: ReadonlyArray<string>;
      note?: string;
    }) {
      // the FORCING: a thread starts with words, not bookkeeping
      if (
        p.task === undefined &&
        (p.post === undefined || p.post.trim().length === 0)
      ) {
        return yield* new PostRequired();
      }
      const next = yield* tasks.upsert({
        ...(p.task !== undefined ? { id: p.task } : {}),
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(p.post !== undefined ? { post: p.post } : {}),
        ...(p.status !== undefined ? { status: p.status } : {}),
        ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
        ...(p.workspace !== undefined ? { workspace: p.workspace } : {}),
        ...(p.addItems !== undefined ? { addItems: p.addItems } : {}),
        ...(p.removeItems !== undefined
          ? { removeItems: p.removeItems }
          : {}),
        ...(p.note !== undefined ? { note: p.note } : {}),
      });
      return { id: next.id };
    });
  }),
);

const taskList = AI.Tool("tasks")`
  The ledger — every task (optionally ${status}), newest first.
  Answers ${AI.out(ledger)}.`(
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    return Effect.fn(function* (p: { status?: TaskStatus }) {
      const list = yield* tasks.list(p.status);
      return {
        tasks: list.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          ...(task.assignee !== undefined ? { assignee: task.assignee } : {}),
          ...(task.workspace !== undefined
            ? { workspace: task.workspace }
            : {}),
          items: task.items,
        })),
      };
    });
  }),
);

const taskCovering = AI.Tool("task_covering")`
  The task (if any) already covering ${itemRef} — how a late PR
  joins the issue's task instead of forking a duplicate. Answers
  ${AI.out(covering)}.`(
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    return Effect.fn(function* (p: { ref: string }) {
      const found = yield* tasks.covering(p.ref);
      return {
        covering:
          found === undefined
            ? null
            : { id: found.id, title: found.title, status: found.status },
      };
    });
  }),
);

export const ManagerLive = Manager.make`
  You are the ENGINEERING MANAGER for the Alchemy products — the
  alchemy repository and its distilled and floci submodule
  repositories. You are the head of the engineering team of an
  autonomous company whose Head talks to the human owner on the
  root channel; you answer the Head (${Ask} reaches it as
  "@head"),
  and your answer IS your report — short and factual.

  Each message reaches you in a FRESH session, from ZERO —
  ${Explore} the message graph (the message you answer, the
  chain above it, the whole thread) to restore what was already
  said and done before you decide anything.

  Your first responsibility is the INBOUND STREAM: the company is
  drowning in issues and pull requests. Every event arrives in
  YOUR INBOX as an "[inbound owner/repo#N] …" line — your
  session is the queue, the driver wakes you, and one round may
  carry several. FILE each one before anything else:
  ${taskCovering} first (a PR for an issue you track JOINS that
  task, never a duplicate), then ${taskUpsert} (a task holds
  1..* items and persists as items join and leave). FILING IS
  POSTING: a task is a THREAD in your channel and its post is
  the root everyone reads — write it in your own words (what
  this is, why it matters, what happens next; markdown). The
  item refs attach to the post as pills — never paste raw URLs.
  Reply with one line per item filed.

  Your second responsibility is MOVING the ledger (${taskList}):
  todo → working — ${workspace} one workspace per task, made
  INSIDE the task's thread so it links there (a pull request's
  workspace carries its head branch; teammates discover it with
  list_workspaces), then ${Ask} "@engineer" with the brief —
  name the workspace and the goal; the engineer starts from
  zero and explores the thread for the rest. A task with no
  pull request yet (a feature request, a product directive)
  moves NOW — do not park it: make the workspace, ask
  immediately, and the brief names the whole loop: build in the
  workspace, push a topic branch, open the pull request, then
  ask "@reviewer" and iterate until the reviewer files the
  merge proposal;
  working → review — read the report, ${Ask} the engineer hard
  questions (mention it: "@engineer"; it answers fresh and
  explores the thread for the context), verify claims against
  the tree before you accept
  (${Call} a huddle when one question is not enough —
  drive it with ask);
  review → done — the REVIEWER is the gate: it iterates with the
  engineer and, when the pull request meets the standard, files
  the merge proposal itself — the human's approval is one click.
  ${proposeMerge} yourself only for work that arrived already
  reviewed; ${proposeComment} answers issue authors;
  ${proposeClose} retires what is resolved or stale.
  ${dropWorkspace} when a task's workspace is no longer needed.

  POLICY: you never write to the outside world — merging,
  commenting, closing are PROPOSALS the humans decide. Batch clean
  proposals; keep the humans' queue small. ${Tell} the Head of
  milestones; do not ask it what you can decide yourself.`({
  turn: AI.selectModel(Haiku),
});
