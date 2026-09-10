import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as GitHub from "alchemy/GitHub";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import type { CursorPage } from "../platform/Cursor.ts";

/**
 * The CHANNEL — one for the whole org. Everything the operator sees in
 * the main view is a {@link ChannelMessage} in its one append-only log:
 * events from the outside world (GitHub webhooks), the operator's own
 * control messages (the only thing that runs the channel agent), and
 * explicit posts from threads (cards). Nothing else is written here —
 * thread conversations live in their agent sessions.
 */

/** Who wrote a message — a GitHub login (avatars derive from it). */
export interface ChannelAuthor {
  readonly login: string;
}

export type ChannelMessageKind =
  /** An event from the outside world (a GitHub delivery). */
  | "event"
  /** The operator speaking — the one kind that runs the channel agent. */
  | "user"
  /** The channel agent's reply to the operator. */
  | "agent"
  /** A thread reaching the control plane: a notification. */
  | "card";

/** What a card offers beyond its text: one place to go. */
export interface ChannelCard {
  /** The thread that posted it. */
  readonly thread: string;
  /** One line — the card's headline. */
  readonly title: string;
  /** When the card concerns a reviewable entity: jump to its review. */
  readonly review?: {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
  };
}

export interface ChannelMessage {
  readonly id: string;
  /** Dense position in the channel log — the cursor protocol's unit. */
  readonly seq: number;
  readonly at: number;
  readonly kind: ChannelMessageKind;
  /** Absent for messages nobody signed (a bare push). */
  readonly author: ChannelAuthor | undefined;
  /** Markdown. Pills are `[label](anchor://…)` links. */
  readonly text: string;
  /** `owner/repo` for event rows — repos are a fact, not a scope. */
  readonly repo?: string;
  /** `owner/repo#N` when the message concerns one entity. */
  readonly ref?: string;
  /** The event's tag (`IssueOpened`, …) for event rows. */
  readonly event?: string;
  /** The thread this message belongs to (tagged by the owning thread). */
  readonly thread?: string;
  /** `true` when the channel agent PLACED it into that thread. */
  readonly placed?: boolean;
  readonly card?: ChannelCard;
  /**
   * The messages this one answers (the operator replying inline, one
   * or several). Ids, not seqs — a deleted original leaves a dangling
   * id the UI renders as "deleted".
   */
  readonly replyTo?: ReadonlyArray<string>;
}

/** A thread's row in the channel's directory — what the rail lists. */
export interface ThreadDirectoryRow {
  readonly id: string;
  /** Short handle (`do-init`) — the rail's label. */
  readonly name: string;
  /** One line — what the thread is about. */
  readonly title: string;
  readonly status: "open" | "closed";
  /** Whose turn: drives the rail's grouping. */
  readonly turn: "you" | "agents" | "others" | "idle";
  readonly updatedAt: number;
}

/** What `deliver` reports back to the ingest loop. */
export interface Delivered {
  /** The delivery was seen before — nothing was written. */
  readonly duplicate: boolean;
  /** The thread that owns the event's ref, when one is assigned. */
  readonly owner: string | undefined;
  readonly message: ChannelMessage | undefined;
}

export interface SearchFilter {
  /** Substring over text (case-insensitive). */
  readonly q?: string;
  /** Clamp: only rows with `seq <= before` (the run's pin). */
  readonly before?: number;
  readonly author?: string;
  readonly thread?: string;
  readonly kind?: ChannelMessageKind;
  readonly limit?: number;
}

/** What a writer hands `append` — the DO mints seq (and id if absent). */
export interface AppendInput {
  readonly id?: string;
  readonly kind: ChannelMessageKind;
  readonly author?: ChannelAuthor;
  readonly text: string;
  readonly repo?: string;
  readonly ref?: string;
  readonly event?: string;
  readonly thread?: string;
  readonly card?: ChannelCard;
  readonly replyTo?: ReadonlyArray<string>;
}

/**
 * The channel, as the rest of the org addresses it — a facade over the
 * one ChannelDO instance (`main`). Every write is idempotent on the
 * message id; `deliver` is idempotent on the event's content.
 */
export class Channel extends Context.Service<
  Channel,
  {
    /** A GitHub delivery: dedupe, append the event row, name the owner. */
    readonly deliver: (
      event: GitHub.RepositoryEvent,
    ) => Effect.Effect<Delivered>;
    readonly append: (input: AppendInput) => Effect.Effect<ChannelMessage>;
    /** Amend a delivered row in place (card status, thread tag). */
    readonly update: (
      id: string,
      patch: {
        readonly text?: string;
        readonly card?: ChannelCard;
      },
    ) => Effect.Effect<ChannelMessage | undefined>;
    /** Tag rows as belonging (placed) to a thread; `null` untags. */
    readonly tag: (
      ids: ReadonlyArray<string>,
      thread: string | null,
      placed: boolean,
    ) => Effect.Effect<void>;
    /**
     * DELETE rows by id — the operator pruning the log. Retired seqs
     * are never re-minted (the DO's head counter is monotonic), so
     * cursor watermarks stay valid. Unknown ids are ignored.
     */
    readonly remove: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
    readonly page: (options?: {
      readonly after?: number;
      readonly limit?: number;
    }) => Effect.Effect<CursorPage<ChannelMessage>>;
    readonly search: (
      filter: SearchFilter,
    ) => Effect.Effect<ReadonlyArray<ChannelMessage>>;
    readonly read: (
      ids: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<ChannelMessage>>;
    /** The rail's list — projections pushed by the threads. */
    readonly directory: () => Effect.Effect<ReadonlyArray<ThreadDirectoryRow>>;
    readonly directoryUpsert: (row: ThreadDirectoryRow) => Effect.Effect<void>;
    /** Drop a thread's row (a deleted thread) — the rail forgets it. */
    readonly directoryRemove: (id: string) => Effect.Effect<void>;
    /** `ref → thread` ownership, pushed by the threads on assign/unassign. */
    readonly attachmentsSet: (
      ref: string,
      thread: string | null,
    ) => Effect.Effect<void>;
    readonly attachmentOf: (ref: string) => Effect.Effect<string | undefined>;
    /** Claim the one-time bootstrap; `true` exactly once. */
    readonly claimBootstrap: () => Effect.Effect<boolean>;
    /** Route the `/channel` WebSocket upgrade into the DO. */
    readonly socket: (
      request: HttpServerRequest,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
  }
>()("alchemy-org/Channel") {}

/** `owner/repo#N` — the one way an entity is named anywhere. */
export const refOf = (repo: string, number: number): string =>
  `${repo}#${number}`;

/** Parse `owner/repo#N`; `undefined` when it is not one. */
export const parseEntityRef = (
  ref: string,
): { owner: string; repo: string; number: number } | undefined => {
  const match = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(ref);
  if (match === null) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    number: Number(match[3]!),
  };
};
