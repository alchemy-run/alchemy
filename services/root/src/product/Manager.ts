import * as AI from "alchemy/AI";
import * as PersistentRef from "alchemy/PersistentRef";
import * as Effect from "effect/Effect";
import * as S from "effect/Schema";
import { Ask, Tell } from "../chat/Ask.ts";
import { Call } from "../chat/Call.ts";
import { Tasks, type TaskStatus } from "../engineering/Tasks.ts";
import { makeEntityTools } from "../github/Entity.ts";
import { models } from "../platform/Model.ts";

/**
 * The PRODUCT MANAGER — the head of the product group; its session is
 * the `#product` channel, where the humans initiate conversations
 * about CHANGES to the product ("add stripe resources"). It accepts
 * the first message, sharpens it into a described GOAL, and allocates
 * it — a dedicated task, or folded into an existing one — through a
 * chain of 1..* asks to the agents who own the work (the
 * engineering-manager owns the ledger and the staffing).
 *
 * It reads the ledger; it never writes it. Allocation is a
 * CONVERSATION: the ask chain is the same message tree everything
 * else lives in, and the task it lands is the thread the human is
 * pointed back to.
 */
export class ProductManager extends AI.Agent<
  ProductManager,
  ProductManagerApi
>(import.meta)("ProductManager") {}

export interface ProductManagerApi {
  /** The session's current pick; `undefined` = the org's default. */
  readonly model: () => Effect.Effect<string | undefined>;
  readonly setModel: (model: string | undefined) => Effect.Effect<void>;
}

const status = AI.Thing(
  "status",
  S.optionalKey(S.Literals(["todo", "working", "review", "done"])),
)`
  Filter by where the work stands.`;

const itemRef = AI.Thing("ref", S.String)`
  An item ref — "owner/repo#N".`;

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

export const ProductManagerLive = ProductManager.make(
  Effect.gen(function* () {
    const model = yield* models;
    const tasks = yield* Tasks;
    const { readIssue, readPull } = yield* makeEntityTools;

    const chosen = PersistentRef.of<string | null>("model", () => null);

    const taskList = yield* AI.Tool("tasks")`
      The engineering ledger, read-only — every task (optionally
      ${status}), newest first. Answers ${AI.out(ledger)}.`(
      Effect.fn(function* (p: { status?: TaskStatus }) {
        const list = yield* tasks.list(p.status);
        return {
          tasks: list.map((task) => ({
            id: task.id,
            title: task.title,
            status: task.status,
            items: task.items,
          })),
        };
      }),
    );

    const taskCovering = yield* AI.Tool("task_covering")`
      The task (if any) already covering ${itemRef}, read-only — how
      you tell "fold into existing" from "needs its own". Answers
      ${AI.out(covering)}.`(
      Effect.fn(function* (p: { ref: string }) {
        const found = yield* tasks.covering(p.ref);
        return {
          covering:
            found === undefined
              ? null
              : { id: found.id, title: found.title, status: found.status },
        };
      }),
    );

    return {
      turn: Effect.gen(function* () {
        const pick = yield* chosen;
        return yield* AI.fragment`
        You are the PRODUCT MANAGER of an autonomous company building
        the Alchemy products (the alchemy IaC framework, its distilled
        SDKs, the floci emulator). Your session is the #product
        channel: the humans open conversations here about CHANGES to
        the product — "add stripe resources", "we need a dashboard",
        "kill the legacy CLI flags".

        YOU accept the first message. Your job on each conversation:

        1. SHARPEN the goal. A task is a collection of items and a
           DESCRIBED GOAL — if the goal isn't crisp enough to describe
           in two sentences, ask the human ONE question. Don't
           interrogate; most requests are clear enough to move on.
        2. CHECK the ledger before allocating: ${taskCovering} for any
           refs in play, ${taskList} for related work — an existing
           task that covers this FOLDS the request in; nothing
           covering it means a dedicated task.
        3. ALLOCATE through asks. You do not write the ledger — the
           engineering-manager owns it. ${Ask} "engineering-manager"
           to file the task (give it the described goal, the items,
           and whether it's new or folds into t-…); its answer carries
           the task id. Chains nest: the manager may ask its
           engineers, those may ask further — every chain bubbles back
           to you.
        4. ANSWER the human with the outcome: the task id (write it
           bare — t-… renders as the thread), what was decided, and
           what happens next. Short.

        ${Tell} for notes needing no answer; ${Call} several agents
        into one conversation when scoping needs many heads.
        ${readIssue} and ${readPull} read GitHub when the conversation
        references them.

        POLICY: you never write to the outside world, and you never
        promise dates. The structure of the company is CODE — process
        changes are pull requests, not ceremonies you invent.`.pipe(
          Effect.provide(model(pick === null ? undefined : pick)),
        );
      }),
      model: () =>
        Effect.map(chosen, (pick) => (pick === null ? undefined : pick)),
      setModel: (next: string | undefined) =>
        PersistentRef.set(chosen, next ?? null),
    };
  }),
);
