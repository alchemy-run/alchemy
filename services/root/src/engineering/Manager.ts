import * as AI from "alchemy/AI";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { Ask, Tell } from "../chat/Ask.ts";
import { Call } from "../chat/Call.ts";
import { makeProposalTools } from "../proposals/Propose.ts";
import { lineage } from "../Root.ts";
import { makeWorkspaceTools } from "../sandbox/WorkspaceTools.ts";
import { Engineer } from "./Engineer.ts";
import { Tasks, type TaskItem, type TaskStatus } from "./Tasks.ts";

/**
 * The ENGINEERING MANAGER — the head of the engineering team, the
 * agent managing ITS thread the way the Head manages the Root: the
 * recursion IS the org.
 *
 * The inbound world arrives in ITS OWN SESSION INBOX (the session is
 * the queue — Triage.ts dedupes and pumps, the driver wakes); it files
 * each item into the TASK LEDGER (Tasks.ts), moves the
 * ledger todo → working → review → done, staffs engineers (one
 * workspace per task), verifies their output, and stages merge
 * proposals so the humans' approval is one click. It answers the Head
 * with short, factual reports — its answer IS the report.
 */
export class EngineeringManager extends AI.Agent<EngineeringManager>(
  import.meta,
)("EngineeringManager") {}

const shortId = (): string => Math.random().toString(36).slice(2, 8);

const brief = AI.Thing("brief", S.String)`
  The engineer's whole task, self-contained: the goal, the constraints,
  the repository facts it needs, and what DONE means (typically: a
  branch pushed and a pull request opened). It does not see your
  conversation.`;

const workspaceOf = AI.Thing("workspace", S.String)`
  The workspace (by name) the engineer works in — its DEFAULT: shell
  and relative paths land there; "@<name>/…" reaches siblings.`;

const agentKey = AI.Thing("agent", S.String)`
  The engineer's name ("e-4f2a") — ask/tell address it; read its
  session for the full transcript.`;

const report = AI.Thing("report", S.String)`
  The engineer's final reply — its own words, ending with what it
  produced (branches, pull requests, findings).`;

const taskId = AI.Thing("task", S.optionalKey(S.String))`
  An existing task's id — omit to create one.`;

const title = AI.Thing("title", S.optionalKey(S.String))`
  The task's one-line title.`;

const status = AI.Thing(
  "status",
  S.optionalKey(S.Literals(["todo", "working", "review", "done"])),
)`
  Where the work stands.`;

const assignee = AI.Thing("assignee", S.optionalKey(S.String))`
  The engineer working it ("e-4f2a").`;

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

export const EngineeringManagerLive = EngineeringManager.make(
  Effect.gen(function* () {
    const tasks = yield* Tasks;
    const engineer = yield* Engineer;
    const { workspace, dropWorkspace } = yield* makeWorkspaceTools;
    const { proposeComment, proposeMerge, proposeClose } =
      yield* makeProposalTools;

    const taskUpsert = yield* AI.Tool("task_upsert")`
      Create or update a task — the unit of work. A task holds 1..*
      items (an issue, a PR, both — a late PR JOINS the issue's task,
      never forks a duplicate: check task_covering first). Move status
      todo → working → review → done as the work moves; record the
      assignee ("e-…") and the workspace when work starts; append a
      note for anything the ledger should remember: ${AI.in(
        taskId,
        title,
        status,
        assignee,
        taskWorkspace,
        addItems,
        removeItems,
        taskNote,
      )}.`(
      Effect.fn(function* (p: {
        task?: string;
        title?: string;
        status?: TaskStatus;
        assignee?: string;
        workspace?: string;
        addItems?: ReadonlyArray<TaskItem>;
        removeItems?: ReadonlyArray<string>;
        note?: string;
      }) {
        const next = yield* tasks.upsert({
          ...(p.task !== undefined ? { id: p.task } : {}),
          ...(p.title !== undefined ? { title: p.title } : {}),
          ...(p.status !== undefined ? { status: p.status } : {}),
          ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
          ...(p.workspace !== undefined ? { workspace: p.workspace } : {}),
          ...(p.addItems !== undefined ? { addItems: p.addItems } : {}),
          ...(p.removeItems !== undefined
            ? { removeItems: p.removeItems }
            : {}),
          ...(p.note !== undefined ? { note: p.note } : {}),
        });
        return { task: next.id, status: next.status };
      }),
    );

    const taskList = yield* AI.Tool("tasks")`
      The ledger — every task (optionally one status), newest first.`(
      Effect.fn(function* (p: { status?: TaskStatus }) {
        return { tasks: yield* tasks.list(p.status) };
      }),
    );

    const taskCovering = yield* AI.Tool("task_covering")`
      The task (if any) already covering ${itemRef} — how a late PR
      joins the issue's task instead of forking a duplicate.`(
      Effect.fn(function* (p: { ref: string }) {
        const found = yield* tasks.covering(p.ref);
        return found === undefined ? { task: undefined } : { task: found };
      }),
    );

    const spawn = yield* AI.Tool("spawn")`
      Kick off an ENGINEER with ${brief} in ${workspaceOf} — its own
      session, full editor and shell, push and open-pull-request tools
      behind the human gate. The call returns when the engineer
      settles — answers ${AI.out(agentKey, report)}; while it works it
      can ask you (and you it, by its name). Spawn engineers in
      parallel only for INDEPENDENT tasks; one workspace, one
      engineer.`(
      Effect.fn(function* (p: { brief: string; workspace: string }) {
        const name = `e-${shortId()}`;
        const key = lineage(name);
        const me = yield* AI.Thread;
        yield* engineer.at(key).setWorkspace(p.workspace);
        const outcome = yield* engineer.dispatch(p.brief, {
          key,
          parent: { term: "EngineeringManager", key: me.key },
        });
        return {
          agent: name,
          report:
            typeof outcome === "string" ? outcome : JSON.stringify(outcome),
        };
      }),
    );

    return {
      turn: AI.fragment`
        You are the ENGINEERING MANAGER for the Alchemy products — the
        alchemy repository and its distilled and floci submodule
        repositories. You are the head of the engineering team of an
        autonomous company whose Head talks to the human owner on the
        root channel; you answer the Head (${Ask} reaches it as "head"),
        and your answer IS your report — short and factual.

        Your first responsibility is the INBOUND STREAM: the company is
        drowning in issues and pull requests. Every event arrives in
        YOUR INBOX as an "[inbound owner/repo#N] …" line — your
        session is the queue, the driver wakes you, and one round may
        carry several. FILE each one before anything else:
        ${taskCovering} first (a PR for an issue you track JOINS that
        task, never a duplicate), then ${taskUpsert} (a task holds
        1..* items and persists as items join and leave). Reply with
        one line per item filed.

        Your second responsibility is MOVING the ledger (${taskList}):
        todo → working — ${workspace} one workspace per task (a pull
        request's workspace carries its head branch) and ${spawn} an
        engineer in it with a self-contained brief;
        working → review — read the report, ${Ask} the engineer hard
        questions, verify claims against the tree before you accept
        (${Call} a huddle of engineers when one question is not enough —
        drive it with ask);
        review → done — get the pull request CLEAN (green, reviewed,
        described), then ${proposeMerge} so the human's approval is one
        click; ${proposeComment} answers issue authors; ${proposeClose}
        retires what is resolved or stale. ${dropWorkspace} when a
        task's workspace is no longer needed.

        POLICY: you never write to the outside world — merging,
        commenting, closing are PROPOSALS the humans decide. Batch clean
        proposals; keep the humans' queue small. ${Tell} the Head of
        milestones; do not ask it what you can decide yourself.`,
    };
  }),
);
