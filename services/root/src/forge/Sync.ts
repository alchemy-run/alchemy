/**
 * SYNC — the one-way GitHub → forge mirror (the plan's Phase 3).
 *
 * Pages the real GitHub REST API with the org's token and upserts
 * into the Issues store under the FORGE's repo names
 * (`alchemy-run/alchemy` → `org/alchemy`): issues (PRs ride along as
 * `is_pull` rows with head/base/merged), then repo-wide comments.
 * Idempotent — every row upserts by its GitHub identity, so the
 * routes can be hit any time:
 *
 * - `POST /api/forge/sync` (org credential) — run the backfill
 * - `GET  /api/forge/sync` — per-repo mirror counts
 *
 * Event-driven increments join in the Forge swap phase; this is the
 * paged crawl that seeds and repairs the mirror.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { PublishToken } from "../github/PublishToken.ts";
import { credential, forgeSecret } from "./GitAuth.ts";
import { Issues, type CommentRow, type IssueRow } from "./Issues.ts";
import { SEEDS } from "./Seed.ts";

/** GitHub source ↔ forge identity, derived from the seed list. */
export const MIRRORS = SEEDS.map((seed) => ({
  forge: `${seed.owner}/${seed.name}`,
  github: new URL(seed.url).pathname.replace(/^\//, "").replace(/\.git$/, ""),
}));

/** Page cap per listing — 100 rows each; a manual dev sync's bound. */
const MAX_PAGES = 30;

interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly user: { readonly login: string } | null;
  readonly labels: ReadonlyArray<{ readonly name?: string } | string>;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
  readonly pull_request?: { readonly merged_at: string | null };
  readonly draft?: boolean;
}

interface GitHubPull {
  readonly number: number;
  readonly head: { readonly ref: string };
  readonly base: { readonly ref: string };
  readonly merged_at: string | null;
  readonly draft?: boolean;
}

interface GitHubComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly login: string } | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly issue_url: string;
}

const labelNames = (
  labels: GitHubIssue["labels"],
): ReadonlyArray<string> =>
  labels.map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter((name) => name.length > 0);

export interface SyncReport {
  readonly repo: string;
  readonly issues: number;
  readonly pulls: number;
  readonly comments: number;
}

/** Crawl one GitHub repo into the mirror; answer what was written. */
const syncRepo = Effect.fn(function* (mirror: {
  forge: string;
  github: string;
}) {
  const issues = yield* Issues;
  const readToken = yield* PublishToken;
  const client = yield* HttpClient.HttpClient;
  const token = Redacted.value(yield* readToken);

  const page = Effect.fn(function* (path: string, index: number) {
    const response = yield* client.get(
      `https://api.github.com/repos/${mirror.github}/${path}` +
        `${path.includes("?") ? "&" : "?"}per_page=100&page=${index}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "root-forge-sync",
        },
      },
    );
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`github ${path} page ${index}: ${response.status}`),
      );
    }
    return (yield* response.json) as ReadonlyArray<unknown>;
  });

  const crawl = Effect.fn(function* (path: string) {
    const all: Array<unknown> = [];
    for (let index = 1; index <= MAX_PAGES; index++) {
      const batch = yield* page(path, index);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all;
  });

  // 1. every issue AND pull (the issues listing carries both)
  const issueRows = (yield* crawl(
    "issues?state=all&sort=updated&direction=desc",
  )) as ReadonlyArray<GitHubIssue>;

  // 2. pull detail (head/base/merged) to enrich the is_pull rows
  const pullRows = (yield* crawl(
    "pulls?state=all&sort=updated&direction=desc",
  )) as ReadonlyArray<GitHubPull>;
  const pullByNumber = new Map(pullRows.map((pull) => [pull.number, pull]));

  const mapped: Array<IssueRow> = issueRows.map((issue) => {
    const pull =
      issue.pull_request === undefined
        ? undefined
        : pullByNumber.get(issue.number);
    return {
      repo: mirror.forge,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      author: issue.user?.login ?? "ghost",
      labels: labelNames(issue.labels),
      isPull: issue.pull_request !== undefined,
      headRef: pull?.head.ref ?? null,
      baseRef: pull?.base.ref ?? null,
      merged:
        (issue.pull_request?.merged_at ?? pull?.merged_at ?? null) !== null,
      draft: pull?.draft ?? issue.draft ?? false,
      createdAt: Date.parse(issue.created_at),
      updatedAt: Date.parse(issue.updated_at),
      closedAt: issue.closed_at === null ? null : Date.parse(issue.closed_at),
      origin: "github",
    };
  });
  yield* issues.upsertIssues(mapped);

  // 3. repo-wide comments; the issue number rides the issue_url
  const commentRows = (yield* crawl(
    "issues/comments?sort=created&direction=desc",
  )) as ReadonlyArray<GitHubComment>;
  const comments: Array<CommentRow> = commentRows.flatMap((comment) => {
    const match = /\/issues\/(\d+)$/.exec(comment.issue_url);
    if (match === null) return [];
    return [
      {
        repo: mirror.forge,
        issueNumber: Number(match[1]),
        id: comment.id,
        author: comment.user?.login ?? "ghost",
        body: comment.body,
        createdAt: Date.parse(comment.created_at),
        updatedAt: Date.parse(comment.updated_at),
        origin: "github" as const,
      },
    ];
  });
  yield* issues.upsertComments(comments);

  const counts = yield* issues.counts(mirror.forge);
  return { repo: mirror.forge, ...counts } satisfies SyncReport;
});

export const SyncApi = Effect.gen(function* () {
  const issues = yield* Issues;
  const publishToken = yield* PublishToken;
  const secret = Redacted.value(yield* forgeSecret);

  const run = HttpRouter.add(
    "POST",
    "/api/forge/sync",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      if (credential(request.headers) !== secret) {
        return HttpServerResponse.jsonUnsafe(
          { message: "Requires authentication" },
          { status: 401 },
        );
      }
      const reports: Array<SyncReport | { repo: string; error: string }> = [];
      for (const mirror of MIRRORS) {
        const report = yield* syncRepo(mirror).pipe(
          Effect.provideService(Issues, issues),
          Effect.provideService(PublishToken, publishToken),
          Effect.catchCause((cause) =>
            Effect.succeed({
              repo: mirror.forge,
              error: String(cause).slice(0, 200),
            }),
          ),
        );
        reports.push(report);
      }
      return yield* HttpServerResponse.json({ mirrors: reports });
    }),
  );

  const status = HttpRouter.add(
    "GET",
    "/api/forge/sync",
    Effect.gen(function* () {
      const reports: Array<SyncReport> = [];
      for (const mirror of MIRRORS) {
        const counts = yield* issues.counts(mirror.forge);
        reports.push({ repo: mirror.forge, ...counts });
      }
      return yield* HttpServerResponse.json({ mirrors: reports });
    }),
  );

  return Layer.mergeAll(run, status);
});
