/**
 * ISSUES — the forge's app-level store, GitHub-shaped.
 *
 * The git server deliberately has no issues; this is the org's own
 * table. Rows are the GitHub REST v3 issue/comment shapes (so the
 * ecosystem — our tools, `gh api`, the UI — reads them unchanged),
 * mirrored FROM GitHub (Sync.ts) or created in-app. Pull requests
 * mirror here too as issue rows with `is_pull` (head/base/merged
 * riding along) — the LIST view's one table; native local pulls
 * live in the git server itself.
 *
 * Numbering: mirrored rows keep their GitHub numbers; a local
 * creation allocates above the repo's high-water mark, so the two
 * origins never collide.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RuntimeContext } from "alchemy/RuntimeContext";

/** One stored issue (or mirrored pull request), v3-shaped on read. */
export interface IssueRow {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly author: string;
  readonly labels: ReadonlyArray<string>;
  readonly isPull: boolean;
  readonly headRef: string | null;
  readonly baseRef: string | null;
  readonly merged: boolean;
  readonly draft: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  /** `github` (mirrored) or `local` (created in-app). */
  readonly origin: "github" | "local";
}

export interface CommentRow {
  readonly repo: string;
  readonly issueNumber: number;
  /** GitHub's id for mirrored comments; negative for local ones. */
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly origin: "github" | "local";
}

export interface ListIssuesQuery {
  readonly state?: "open" | "closed" | "all";
  /** `issue` | `pull` | `all` — the tabs' split. */
  readonly kind?: "issue" | "pull" | "all";
  readonly page?: number;
  readonly perPage?: number;
}

export interface CreateIssueInput {
  readonly repo: string;
  readonly title: string;
  readonly body?: string | undefined;
  readonly author: string;
  readonly labels?: ReadonlyArray<string> | undefined;
}

export interface UpdateIssueInput {
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly state?: "open" | "closed" | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
}

/** The store — implemented by IssuesDO's facade (`IssuesLive`). */
export class Issues extends Context.Service<
  Issues,
  {
    /** Idempotent mirror writes (Sync.ts) — keyed `(repo, number)`. */
    readonly upsertIssues: (
      rows: ReadonlyArray<IssueRow>,
    ) => Effect.Effect<void, never, RuntimeContext>;
    /** Idempotent mirror writes — keyed `(repo, id)`. */
    readonly upsertComments: (
      rows: ReadonlyArray<CommentRow>,
    ) => Effect.Effect<void, never, RuntimeContext>;
    readonly get: (
      repo: string,
      number: number,
    ) => Effect.Effect<IssueRow | undefined, never, RuntimeContext>;
    readonly list: (
      repo: string,
      query: ListIssuesQuery,
    ) => Effect.Effect<ReadonlyArray<IssueRow>, never, RuntimeContext>;
    readonly listComments: (
      repo: string,
      issueNumber: number,
    ) => Effect.Effect<ReadonlyArray<CommentRow>, never, RuntimeContext>;
    readonly commentCounts: (
      repo: string,
      numbers: ReadonlyArray<number>,
    ) => Effect.Effect<Readonly<Record<number, number>>, never, RuntimeContext>;
    /** Allocates the next number above the repo's high-water mark. */
    readonly create: (
      input: CreateIssueInput,
    ) => Effect.Effect<IssueRow, never, RuntimeContext>;
    readonly update: (
      repo: string,
      number: number,
      patch: UpdateIssueInput,
    ) => Effect.Effect<IssueRow | undefined, never, RuntimeContext>;
    readonly addComment: (
      repo: string,
      issueNumber: number,
      input: { readonly author: string; readonly body: string },
    ) => Effect.Effect<CommentRow | undefined, never, RuntimeContext>;
    /** Per-repo `{ issues, pulls, comments }` — the sync report. */
    readonly counts: (
      repo: string,
    ) => Effect.Effect<
      { issues: number; pulls: number; comments: number },
      never,
      RuntimeContext
    >;
  }
>()("root/forge/Issues") {}
