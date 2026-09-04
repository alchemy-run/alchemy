/**
 * The `github` group: a GitHub REST v3 facade at `/api/v3`, so `gh api`
 * and Octokit work against the host unmodified (DESIGN.md §5). The routes
 * answer with GitHub-shaped JSON they build themselves and declare no
 * success schema.
 */
import * as Http from "../../Http/index.ts";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

/** `GET /user`: the credential probe `gh` makes; answer it from your own user record. */
export class GitHubUser extends Http.get<GitHubUser>()("user", "/user", {}) {}

/** `GET /repos/:owner/:repo` */
export class GitHubRepo extends Http.get<GitHubRepo>()(
  "repo",
  "/repos/:owner/:repo",
  {},
) {}

/** `GET /repos/:owner/:repo/branches` */
export class GitHubBranches extends Http.get<GitHubBranches>()(
  "branches",
  "/repos/:owner/:repo/branches",
  {},
) {}

/** `GET /repos/:owner/:repo/commits` */
export class GitHubCommits extends Http.get<GitHubCommits>()(
  "commits",
  "/repos/:owner/:repo/commits",
  {},
) {}

/** `GET /repos/:owner/:repo/commits/:sha` */
export class GitHubCommit extends Http.get<GitHubCommit>()(
  "commit",
  "/repos/:owner/:repo/commits/:sha",
  {},
) {}

/** `GET /repos/:owner/:repo/contents/*` */
export class GitHubContents extends Http.get<GitHubContents>()(
  "contents",
  "/repos/:owner/:repo/contents/*",
  {},
) {}

/** `GET /repos/:owner/:repo/pulls` */
export class GitHubPulls extends Http.get<GitHubPulls>()(
  "pulls",
  "/repos/:owner/:repo/pulls",
  {},
) {}

/** `POST /repos/:owner/:repo/pulls` */
export class GitHubCreatePull extends Http.post<GitHubCreatePull>()(
  "createPull",
  "/repos/:owner/:repo/pulls",
  {},
) {}

/** `GET /repos/:owner/:repo/pulls/:number` */
export class GitHubPull extends Http.get<GitHubPull>()(
  "pull",
  "/repos/:owner/:repo/pulls/:number",
  {},
) {}

/** `PATCH /repos/:owner/:repo/pulls/:number` */
export class GitHubUpdatePull extends Http.patch<GitHubUpdatePull>()(
  "updatePull",
  "/repos/:owner/:repo/pulls/:number",
  {},
) {}

/** `PUT /repos/:owner/:repo/pulls/:number/merge` */
export class GitHubMergePull extends Http.put<GitHubMergePull>()(
  "mergePull",
  "/repos/:owner/:repo/pulls/:number/merge",
  {},
) {}

/** `GET /repos/:owner/:repo/pulls/:number/files` */
export class GitHubPullFiles extends Http.get<GitHubPullFiles>()(
  "pullFiles",
  "/repos/:owner/:repo/pulls/:number/files",
  {},
) {}

/** The GitHub facade, mounted at `/api/v3`. */
export class GitHub extends HttpApiGroup.make("github")
  .add(
    GitHubUser,
    GitHubRepo,
    GitHubBranches,
    GitHubCommits,
    GitHubCommit,
    GitHubContents,
    GitHubPulls,
    GitHubCreatePull,
    GitHubPull,
    GitHubUpdatePull,
    GitHubMergePull,
    GitHubPullFiles,
  )
  .prefix("/api/v3") {}
