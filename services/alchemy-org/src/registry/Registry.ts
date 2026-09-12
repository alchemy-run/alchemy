import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";

/**
 * The REGISTRY — the org's durable memory of ORGANIZATION, one SQLite
 * database (a Durable Object) for the whole org. GitHub stays the
 * source of truth for entities (issues, pull requests); the Registry
 * holds what the org KNOWS about them: synced snapshots, the groups
 * they are organized into, the typed relations between them, the
 * tasks that cover them (and the threads dispatched to work those
 * tasks), the staged approvals awaiting the operator, and the policy
 * saying which external writes are gated.
 *
 * Organizing the Registry has NO side effects — the channel agent can
 * reshape groups, relations, and tasks freely without touching GitHub
 * or dispatching any work. Dispatch is a separate, explicit act.
 */

/* ── entities ─────────────────────────────────────────────────────── */

export type EntityKind = "issue" | "pull";
export type EntityState = "open" | "closed" | "merged" | "draft";

/** One GitHub issue or pull request as the Registry last saw it. */
export interface RegistryEntity {
  /** `owner/repo#N` — the org-wide address. */
  readonly ref: string;
  readonly kind: EntityKind;
  readonly state: EntityState;
  readonly title: string;
  /** GitHub login of the author. */
  readonly author?: string;
  readonly labels: ReadonlyArray<string>;
  /** Pulls only: the branches. */
  readonly headRef?: string;
  readonly baseRef?: string;
  /** GitHub's updated_at (ms). */
  readonly updatedAt: number;
  /** When the Registry last reconciled this row with GitHub (ms). */
  readonly syncedAt: number;
}

export interface EntityFilter {
  readonly kind?: EntityKind;
  readonly state?: EntityState;
  readonly label?: string;
  /** Only members of this group. */
  readonly group?: string;
  /** Only entities in NO group and NO task — the triage tray. */
  readonly unorganized?: boolean;
  /** Substring over ref + title (case-insensitive). */
  readonly q?: string;
  readonly limit?: number;
}

/* ── organization ─────────────────────────────────────────────────── */

/** A named set of entities — pure organization. */
export interface RegistryGroup {
  readonly id: string;
  readonly name: string;
  readonly purpose?: string;
  readonly createdAt: number;
  readonly refs: ReadonlyArray<string>;
}

export type RelationKind =
  | "fixes"
  | "duplicates"
  | "depends_on"
  | "relates_to"
  | "supersedes";

/** A typed edge between two refs. */
export interface RegistryRelation {
  readonly src: string;
  readonly kind: RelationKind;
  readonly dst: string;
  readonly note?: string;
}

export type TaskStatus =
  | "todo"
  | "dispatched"
  | "in_review"
  | "blocked"
  | "done";

/** A dispatchable unit of work: the refs it covers, and — once
 *  dispatched — the thread working it. */
export interface RegistryTask {
  readonly id: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly groupId?: string;
  readonly threadId?: string;
  readonly note?: string;
  readonly refs: ReadonlyArray<string>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/* ── approvals & policy ───────────────────────────────────────────── */

export type ApprovalKind =
  | "comment"
  | "push"
  | "open_pull"
  | "merge"
  | "close";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "executed"
  | "failed";

/** The staged action, by kind — everything needed to execute later. */
export type ApprovalPayload =
  | { readonly kind: "comment"; readonly ref: string; readonly body: string }
  | {
      readonly kind: "push";
      readonly threadId: string;
      readonly branch: string;
    }
  | {
      readonly kind: "open_pull";
      readonly threadId: string;
      readonly head: string;
      readonly base?: string;
      readonly title: string;
      readonly body: string;
    }
  | { readonly kind: "merge"; readonly ref: string }
  | { readonly kind: "close"; readonly ref: string; readonly reason?: string };

/** The session that staged an approval — told the outcome. */
export interface ApprovalStager {
  readonly term: string;
  readonly key: string;
}

export interface RegistryApproval {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly status: ApprovalStatus;
  /** One line for the card and the board badge. */
  readonly summary: string;
  readonly payload: ApprovalPayload;
  readonly stager: ApprovalStager;
  readonly taskId?: string;
  readonly threadId?: string;
  /** The channel card row surfacing it — flipped in place on decide. */
  readonly cardId?: string;
  /** deny reason / execution result / failure text. */
  readonly outcome?: string;
  readonly createdAt: number;
  readonly decidedAt?: number;
}

export interface StageApprovalInput {
  readonly kind: ApprovalKind;
  readonly summary: string;
  readonly payload: ApprovalPayload;
  readonly stager: ApprovalStager;
  readonly taskId?: string;
  readonly threadId?: string;
  readonly cardId?: string;
}

/* ── the board ────────────────────────────────────────────────────── */

/** One `board()` call: everything the kanban view renders. */
export interface BoardView {
  readonly tasks: ReadonlyArray<
    RegistryTask & {
      /** Open questions/approvals — the card's notification badge. */
      readonly pendingApprovals: number;
    }
  >;
  readonly groups: ReadonlyArray<RegistryGroup>;
  /** Entities organized into NOTHING — visible, not forgotten. */
  readonly triage: ReadonlyArray<RegistryEntity>;
  /** Snapshots for every ref the tasks/groups mention. */
  readonly entities: ReadonlyArray<RegistryEntity>;
  readonly approvals: ReadonlyArray<RegistryApproval>;
}

/** What rides the `/board` socket: full snapshots (small at org scale). */
export type BoardSocketFrame = { readonly type: "board"; readonly board: BoardView };

/* ── the service ──────────────────────────────────────────────────── */

export class Registry extends Context.Service<
  Registry,
  {
    /* entities */
    readonly upsertEntities: (
      entities: ReadonlyArray<Omit<RegistryEntity, "syncedAt">>,
    ) => Effect.Effect<void>;
    readonly queryEntities: (
      filter?: EntityFilter,
    ) => Effect.Effect<ReadonlyArray<RegistryEntity>>;
    /* organization — pure Registry writes, no side effects */
    readonly createGroup: (input: {
      readonly name: string;
      readonly purpose?: string;
      readonly refs?: ReadonlyArray<string>;
    }) => Effect.Effect<RegistryGroup>;
    readonly addToGroup: (
      group: string,
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<RegistryGroup | undefined>;
    readonly removeFromGroup: (
      group: string,
      refs: ReadonlyArray<string>,
    ) => Effect.Effect<RegistryGroup | undefined>;
    readonly relate: (relation: RegistryRelation) => Effect.Effect<void>;
    readonly unrelate: (
      src: string,
      kind: RelationKind,
      dst: string,
    ) => Effect.Effect<void>;
    readonly relationsOf: (
      ref: string,
    ) => Effect.Effect<ReadonlyArray<RegistryRelation>>;
    /* tasks */
    readonly createTask: (input: {
      readonly title: string;
      readonly refs?: ReadonlyArray<string>;
      readonly groupId?: string;
      readonly note?: string;
    }) => Effect.Effect<RegistryTask>;
    readonly updateTask: (
      id: string,
      patch: {
        readonly title?: string;
        readonly status?: TaskStatus;
        readonly note?: string;
        readonly refs?: ReadonlyArray<string>;
      },
    ) => Effect.Effect<RegistryTask | undefined>;
    /** Bind (or unbind) the thread dispatched to work a task. */
    readonly linkThread: (
      id: string,
      threadId: string | null,
    ) => Effect.Effect<RegistryTask | undefined>;
    /** Everything the kanban view renders, one call. */
    readonly board: () => Effect.Effect<BoardView>;
    /* approvals & policy */
    readonly stageApproval: (
      input: StageApprovalInput,
    ) => Effect.Effect<RegistryApproval>;
    readonly readApproval: (
      id: string,
    ) => Effect.Effect<RegistryApproval | undefined>;
    /** Bind the channel card that surfaces an approval — deciding
     *  flips that card in place. */
    readonly attachApprovalCard: (
      id: string,
      cardId: string,
    ) => Effect.Effect<void>;
    readonly decideApproval: (
      id: string,
      status: Exclude<ApprovalStatus, "pending">,
      outcome?: string,
    ) => Effect.Effect<RegistryApproval | undefined>;
    readonly pendingApprovals: () => Effect.Effect<
      ReadonlyArray<RegistryApproval>
    >;
    /** Approvals in a given status — the gate looks for its grant. */
    readonly listApprovals: (
      status: ApprovalStatus,
    ) => Effect.Effect<ReadonlyArray<RegistryApproval>>;
    /** Is this action kind gated behind an Approval? Unset = gated. */
    readonly gated: (kind: ApprovalKind) => Effect.Effect<boolean>;
    readonly setPolicy: (
      kind: ApprovalKind,
      gated: boolean,
    ) => Effect.Effect<void>;
    readonly policy: () => Effect.Effect<
      ReadonlyArray<{ readonly kind: ApprovalKind; readonly gated: boolean }>
    >;
    /* the /board live socket */
    readonly socket: (
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("alchemy-org/Registry") {}
