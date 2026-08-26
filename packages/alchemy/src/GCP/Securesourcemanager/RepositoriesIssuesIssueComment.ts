import * as ssm from "@distilled.cloud/gcp/securesourcemanager_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  catchMissing,
  collectPages,
  encodeOwnership,
  expandName,
  forEachRepository,
  hasOwnershipMarker,
  nameFromOperation,
  normalizeLocation,
  ownedByAlchemy,
  PAGE_SIZE,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  ResourceNotResolved,
  retryConflict,
  sameText,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type RepositoriesIssuesIssueCommentProps = {
  /**
   * Parent issue. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}/issues/{issue}`
   * or the issue id (combined with `repository`). Immutable — changing
   * it replaces the comment.
   */
  issue: string;
  /**
   * Parent repository used when `issue` is a bare id.
   */
  repository?: string;
  /**
   * Region used when `issue` or `repository` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Server-assigned comment id. Set after create. Immutable — changing
   * it replaces the comment.
   */
  commentId?: string;
  /**
   * Comment body. Alchemy prepends an `[alchemy …]` ownership marker
   * because issue comments have no labels field; the marker is stripped
   * from attributes.
   */
  body: string;
};

export type RepositoriesIssuesIssueComment = Resource<
  "GCP.Securesourcemanager.RepositoriesIssuesIssueComment",
  RepositoriesIssuesIssueCommentProps,
  {
    /** Full resource name. */
    name: string;
    /** Server-assigned comment id. */
    commentId: string;
    /** Parent issue resource name. */
    issue: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Comment body with the Alchemy ownership prefix stripped. */
    body: string;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A comment on a Secure Source Manager issue.
 *
 * Comment ids are server-assigned. Changing `commentId` or `issue`
 * replaces the comment. Body updates in place. Ownership for `list` /
 * nuke is stamped into the body (comments have no labels field).
 *
 * ### Creating an Issue Comment
 * **Example:** Reply on an issue
 * ```typescript
 * const comment = yield* GCP.Securesourcemanager.RepositoriesIssuesIssueComment(
 *   "Note",
 *   {
 *     issue: issue.name,
 *     body: "reproduced on main",
 *   },
 * );
 * ```
 *
 * ### Updating an Issue Comment
 * **Example:** Edit the body
 * ```typescript
 * const comment = yield* GCP.Securesourcemanager.RepositoriesIssuesIssueComment(
 *   "Note",
 *   {
 *     issue: issue.name,
 *     commentId: existing.commentId,
 *     body: "reproduced on release",
 *   },
 * );
 * ```
 *
 * @resource
 * @product GCP
 * @category Securesourcemanager
 */
export const RepositoriesIssuesIssueComment =
  Resource<RepositoriesIssuesIssueComment>(
    "GCP.Securesourcemanager.RepositoriesIssuesIssueComment",
  );

const resourceName = (issue: string, commentId: string) =>
  `${issue}/issueComments/${commentId}`;

const expandIssue = (
  issue: string,
  repository: string | undefined,
  project: string,
  location: string,
) => {
  const next = issue.replace(/\/+$/, "");
  if (next.includes("/")) return next;
  const repo = expandName(repository ?? "", project, location, "repositories");
  return repo.length > 0 ? `${repo}/issues/${next}` : next;
};

const toAttrs = (item: ssm.IssueComment, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "issueComments");
  const body = parseOwnership(item.body);
  return {
    name,
    commentId: parsed.id,
    issue: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    body: body.text ?? "",
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        ssm.getProjectsLocationsRepositoriesIssuesIssueComments({ name }),
      );

const listOnIssue = (issue: string) =>
  collectPages(
    ssm.listProjectsLocationsRepositoriesIssuesIssueComments.pages({
      parent: issue,
      pageSize: PAGE_SIZE,
    }),
    (page) => page.issueComments,
  );

const listOnRepository = (repository: string) =>
  Effect.gen(function* () {
    const issues = yield* collectPages(
      ssm.listProjectsLocationsRepositoriesIssues.pages({
        parent: repository,
        pageSize: PAGE_SIZE,
      }),
      (page) => page.issues,
    );
    const pages = yield* Effect.forEach(
      issues.filter((issue) => (issue.name ?? "").length > 0),
      (issue) => listOnIssue(issue.name!),
      { concurrency: 4 },
    );
    return pages.flat();
  });

const findOwned = (issue: string, id: string) =>
  Effect.gen(function* () {
    if (issue.length === 0) return undefined;
    const items = yield* listOnIssue(issue);
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.body)) {
        return item;
      }
    }
    return undefined;
  });

const listOwned = (project: string) =>
  forEachRepository(project, (repository) =>
    listOnRepository(repository).pipe(
      Effect.map((items) =>
        items.filter((item) => hasOwnershipMarker(item.body)),
      ),
    ),
  );

export const RepositoriesIssuesIssueCommentProvider = () =>
  Provider.succeed(RepositoriesIssuesIssueComment, {
    stables: [
      "name",
      "commentId",
      "issue",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      return replaceOnIdentity({
        previousId: olds?.commentId ?? output?.commentId,
        nextId: news.commentId ?? olds?.commentId ?? output?.commentId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: location,
        previousParent: olds?.issue ?? output?.issue,
        nextParent: expandIssue(
          news.issue,
          news.repository,
          env.project,
          location,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const issue = expandIssue(
        olds?.issue ?? output?.issue ?? "",
        olds?.repository ??
          (output === undefined
            ? undefined
            : parseName(output.issue, "issues").parent),
        env.project,
        location,
      );
      const commentId = olds?.commentId ?? output?.commentId;
      const name =
        output?.name ??
        (commentId !== undefined && issue.length > 0
          ? resourceName(issue, commentId)
          : "");
      let existing = yield* getByName(name);
      if (existing === undefined) {
        existing = yield* findOwned(issue, id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseOwnership(existing.body);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item: ssm.IssueComment) =>
          toAttrs(item, env.project),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const issue = expandIssue(
        news.issue,
        news.repository,
        env.project,
        location,
      );
      const ownership = yield* createInternalLabels(id);
      const body = encodeOwnership(ownership, news.body);
      const name =
        output?.name ??
        (news.commentId !== undefined
          ? resourceName(issue, news.commentId)
          : "");

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findOwned(issue, id);
      }

      if (current === undefined) {
        const created = yield* ssm
          .createProjectsLocationsRepositoriesIssuesIssueComments({
            parent: issue,
            body: { body },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const operation = yield* waitForOperation(created);
          const createdName = nameFromOperation(operation);
          if (createdName !== undefined) {
            current = yield* waitUntilExists(
              getByName(createdName),
              createdName,
            );
          }
        }
        if (current === undefined) {
          current = yield* findOwned(issue, id);
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name: name || issue });
      }

      const currentName = current.name ?? name;
      const parsed = parseOwnership(current.body);
      if (!sameText(parsed.text, news.body)) {
        const operation =
          yield* ssm.patchProjectsLocationsRepositoriesIssuesIssueComments({
            name: currentName,
            updateMask: "body",
            body: { body },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(getByName(currentName), currentName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryConflict(
        ssm
          .deleteProjectsLocationsRepositoriesIssuesIssueComments({
            name: output.name,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
