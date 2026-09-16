/**
 * The ISSUES FACADE — GitHub REST v3 issue routes over the forge's
 * own store, beside the git server's `/api/v3` (which deliberately
 * ships none). With these, the ecosystem that already speaks GitHub
 * — our binding tags, `gh api`, the UI — reads and writes OUR
 * issues unchanged:
 *
 * - `GET    /api/v3/repos/:owner/:repo/issues` (state, kind, page)
 * - `POST   /api/v3/repos/:owner/:repo/issues` (org credential)
 * - `GET    /api/v3/repos/:owner/:repo/issues/:number`
 * - `PATCH  /api/v3/repos/:owner/:repo/issues/:number` (org credential)
 * - `GET    /api/v3/repos/:owner/:repo/issues/:number/comments`
 * - `POST   /api/v3/repos/:owner/:repo/issues/:number/comments` (org credential)
 *
 * Reads are public, like the mirrors themselves.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { credential, forgeSecret, ORG_USER } from "./GitAuth.ts";
import { Issues, type CommentRow, type IssueRow } from "./Issues.ts";

/** One issue, GitHub-v3-shaped (what Octokit and `gh api` expect). */
const issueJson = (row: IssueRow, comments: number) => ({
  id: row.number,
  number: row.number,
  title: row.title,
  body: row.body,
  state: row.state,
  locked: false,
  user: { login: row.author, type: "User" },
  labels: row.labels.map((name) => ({ name })),
  assignees: [],
  comments,
  created_at: new Date(row.createdAt).toISOString(),
  updated_at: new Date(row.updatedAt).toISOString(),
  closed_at:
    row.closedAt === null ? null : new Date(row.closedAt).toISOString(),
  draft: row.isPull ? row.draft : undefined,
  ...(row.isPull
    ? {
        pull_request: {
          merged_at: row.merged
            ? new Date(row.closedAt ?? row.updatedAt).toISOString()
            : null,
          head_ref: row.headRef,
          base_ref: row.baseRef,
        },
      }
    : {}),
});

const commentJson = (row: CommentRow) => ({
  id: row.id,
  body: row.body,
  user: { login: row.author, type: "User" },
  created_at: new Date(row.createdAt).toISOString(),
  updated_at: new Date(row.updatedAt).toISOString(),
});

const notFound = HttpServerResponse.jsonUnsafe(
  { message: "Not Found" },
  { status: 404 },
);
const unauthorized = HttpServerResponse.jsonUnsafe(
  { message: "Requires authentication" },
  { status: 401 },
);

export const IssuesApi = Effect.gen(function* () {
  const issues = yield* Issues;
  const secret = Redacted.value(yield* forgeSecret);

  const repoOf = Effect.gen(function* () {
    const params = yield* HttpRouter.params;
    return `${String(params.owner)}/${String(params.repo)}`.toLowerCase();
  });

  const authed = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    return credential(request.headers) === secret;
  });

  const list = HttpRouter.add(
    "GET",
    "/api/v3/repos/:owner/:repo/issues",
    Effect.gen(function* () {
      const repo = yield* repoOf;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://forge");
      const state = (url.searchParams.get("state") ?? "open") as
        | "open"
        | "closed"
        | "all";
      const kind = (url.searchParams.get("kind") ?? "all") as
        | "issue"
        | "pull"
        | "all";
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const rows = yield* issues.list(repo, { state, kind, page, perPage });
      const counts = yield* issues.commentCounts(
        repo,
        rows.map((row) => row.number),
      );
      return yield* HttpServerResponse.json(
        rows.map((row) => issueJson(row, counts[row.number] ?? 0)),
      );
    }),
  );

  const create = HttpRouter.add(
    "POST",
    "/api/v3/repos/:owner/:repo/issues",
    Effect.gen(function* () {
      if (!(yield* authed)) return unauthorized;
      const repo = yield* repoOf;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orDie)) as {
        title?: string;
        body?: string;
        labels?: ReadonlyArray<string>;
      };
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        return HttpServerResponse.jsonUnsafe(
          { message: "title is required" },
          { status: 422 },
        );
      }
      const row = yield* issues.create({
        repo,
        title: body.title,
        body: body.body,
        labels: body.labels,
        author: ORG_USER.name,
      });
      return yield* HttpServerResponse.json(issueJson(row, 0), {
        status: 201,
      });
    }),
  );

  const get = HttpRouter.add(
    "GET",
    "/api/v3/repos/:owner/:repo/issues/:number",
    Effect.gen(function* () {
      const repo = yield* repoOf;
      const params = yield* HttpRouter.params;
      const number = Number(params.number);
      const row = yield* issues.get(repo, number);
      if (row === undefined) return notFound;
      const counts = yield* issues.commentCounts(repo, [number]);
      return yield* HttpServerResponse.json(
        issueJson(row, counts[number] ?? 0),
      );
    }),
  );

  const patch = HttpRouter.add(
    "PATCH",
    "/api/v3/repos/:owner/:repo/issues/:number",
    Effect.gen(function* () {
      if (!(yield* authed)) return unauthorized;
      const repo = yield* repoOf;
      const params = yield* HttpRouter.params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orDie)) as {
        title?: string;
        body?: string;
        state?: "open" | "closed";
        labels?: ReadonlyArray<string>;
      };
      const row = yield* issues.update(repo, Number(params.number), body);
      if (row === undefined) return notFound;
      const counts = yield* issues.commentCounts(repo, [row.number]);
      return yield* HttpServerResponse.json(
        issueJson(row, counts[row.number] ?? 0),
      );
    }),
  );

  const comments = HttpRouter.add(
    "GET",
    "/api/v3/repos/:owner/:repo/issues/:number/comments",
    Effect.gen(function* () {
      const repo = yield* repoOf;
      const params = yield* HttpRouter.params;
      const rows = yield* issues.listComments(repo, Number(params.number));
      return yield* HttpServerResponse.json(rows.map(commentJson));
    }),
  );

  const comment = HttpRouter.add(
    "POST",
    "/api/v3/repos/:owner/:repo/issues/:number/comments",
    Effect.gen(function* () {
      if (!(yield* authed)) return unauthorized;
      const repo = yield* repoOf;
      const params = yield* HttpRouter.params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orDie)) as {
        body?: string;
      };
      if (typeof body.body !== "string" || body.body.trim().length === 0) {
        return HttpServerResponse.jsonUnsafe(
          { message: "body is required" },
          { status: 422 },
        );
      }
      const row = yield* issues.addComment(repo, Number(params.number), {
        author: ORG_USER.name,
        body: body.body,
      });
      if (row === undefined) return notFound;
      return yield* HttpServerResponse.json(commentJson(row), {
        status: 201,
      });
    }),
  );

  /* ── the APP PLANE: the human's door (the UI), same origin as the
     rest of /api — no forge credential, authored as the operator ── */

  const appCreate = HttpRouter.add(
    "POST",
    "/api/forge/repos/:owner/:repo/issues",
    Effect.gen(function* () {
      const repo = yield* repoOf;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orDie)) as {
        title?: string;
        body?: string;
        labels?: ReadonlyArray<string>;
      };
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        return HttpServerResponse.jsonUnsafe(
          { message: "title is required" },
          { status: 422 },
        );
      }
      const row = yield* issues.create({
        repo,
        title: body.title,
        body: body.body,
        labels: body.labels,
        author: "sam",
      });
      return yield* HttpServerResponse.json(issueJson(row, 0), {
        status: 201,
      });
    }),
  );

  const appPatch = HttpRouter.add(
    "PATCH",
    "/api/forge/repos/:owner/:repo/issues/:number",
    Effect.gen(function* () {
      const repo = yield* repoOf;
      const params = yield* HttpRouter.params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orDie)) as {
        title?: string;
        body?: string;
        state?: "open" | "closed";
      };
      const row = yield* issues.update(repo, Number(params.number), body);
      if (row === undefined) return notFound;
      const counts = yield* issues.commentCounts(repo, [row.number]);
      return yield* HttpServerResponse.json(
        issueJson(row, counts[row.number] ?? 0),
      );
    }),
  );

  const appComment = HttpRouter.add(
    "POST",
    "/api/forge/repos/:owner/:repo/issues/:number/comments",
    Effect.gen(function* () {
      const repo = yield* repoOf;
      const params = yield* HttpRouter.params;
      const request = yield* HttpServerRequest.HttpServerRequest;
      const body = (yield* request.json.pipe(Effect.orDie)) as {
        body?: string;
      };
      if (typeof body.body !== "string" || body.body.trim().length === 0) {
        return HttpServerResponse.jsonUnsafe(
          { message: "body is required" },
          { status: 422 },
        );
      }
      const row = yield* issues.addComment(repo, Number(params.number), {
        author: "sam",
        body: body.body,
      });
      if (row === undefined) return notFound;
      return yield* HttpServerResponse.json(commentJson(row), {
        status: 201,
      });
    }),
  );

  return Layer.mergeAll(
    list,
    create,
    get,
    patch,
    comments,
    comment,
    appCreate,
    appPatch,
    appComment,
  );
});
