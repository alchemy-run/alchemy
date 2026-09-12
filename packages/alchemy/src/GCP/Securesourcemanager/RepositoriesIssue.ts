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
  fieldMask,
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

export type RepositoriesIssueProps = {
  /**
   * Parent repository. Full name
   * `projects/{project}/locations/{location}/repositories/{repository}`
   * or the repository id (combined with `location`). Immutable —
   * changing it replaces the issue.
   */
  repository: string;
  /**
   * Region used when `repository` is a bare id.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Server-assigned issue id. Set after create. Immutable — changing it
   * replaces the issue.
   */
  issueId?: string;
  /**
   * Issue title.
   */
  title: string;
  /**
   * Issue body. Alchemy prepends an `[alchemy …]` ownership marker
   * because issues have no labels field; the marker is stripped from
   * attributes.
   */
  body?: string;
};

export type RepositoriesIssue = Resource<
  "GCP.Securesourcemanager.RepositoriesIssue",
  RepositoriesIssueProps,
  {
    /** Full resource name. */
    name: string;
    /** Server-assigned issue id. */
    issueId: string;
    /** Parent repository resource name. */
    repository: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Issue title. */
    title: string;
    /** Issue body with the Alchemy ownership prefix stripped. */
    body: string | undefined;
    /** Server-reported state (`OPEN` or `CLOSED`). */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 close timestamp, if closed. */
    closeTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Secure Source Manager issue.
 *
 * Issue ids are server-assigned. Changing `issueId` or `repository`
 * replaces the issue. Title and body update in place. Ownership for
 * `list` / nuke is stamped into the body (issues have no labels field).
 *
 * ### Creating an Issue
 * **Example:** Open an issue
 * ```typescript
 * const issue = yield* GCP.Securesourcemanager.RepositoriesIssue("Bug", {
 *   repository: repo.name,
 *   title: "webhook retries 500s",
 *   body: "hooks retry forever on 500",
 * });
 * ```
 *
 * ### Updating an Issue
 * **Example:** Edit title and body
 * ```typescript
 * const issue = yield* GCP.Securesourcemanager.RepositoriesIssue("Bug", {
 *   repository: repo.name,
 *   issueId: existing.issueId,
 *   title: "webhook retries 5xx",
 *   body: "cap retries at 8",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Securesourcemanager
 */
export const RepositoriesIssue = Resource<RepositoriesIssue>(
  "GCP.Securesourcemanager.RepositoriesIssue",
);

const resourceName = (repository: string, issueId: string) =>
  `${repository}/issues/${issueId}`;

const toAttrs = (item: ssm.Issue, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "issues");
  const body = parseOwnership(item.body);
  return {
    name,
    issueId: parsed.id,
    repository: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    title: item.title ?? "",
    body: body.text,
    state: item.state,
    createTime: item.createTime,
    updateTime: item.updateTime,
    closeTime: item.closeTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(ssm.getProjectsLocationsRepositoriesIssues({ name }));

const listOnRepository = (repository: string) =>
  collectPages(
    ssm.listProjectsLocationsRepositoriesIssues.pages({
      parent: repository,
      pageSize: PAGE_SIZE,
    }),
    (page) => page.issues,
  );

const findOwned = (repository: string, id: string) =>
  Effect.gen(function* () {
    if (repository.length === 0) return undefined;
    const items = yield* listOnRepository(repository);
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

export const RepositoriesIssueProvider = () =>
  Provider.succeed(RepositoriesIssue, {
    stables: [
      "name",
      "issueId",
      "repository",
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
        previousId: olds?.issueId ?? output?.issueId,
        nextId: news.issueId ?? olds?.issueId ?? output?.issueId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: location,
        previousParent: olds?.repository ?? output?.repository,
        nextParent: expandName(
          news.repository,
          env.project,
          location,
          "repositories",
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const repository = expandName(
        olds?.repository ?? output?.repository ?? "",
        env.project,
        location,
        "repositories",
      );
      const issueId = olds?.issueId ?? output?.issueId;
      const name =
        output?.name ??
        (issueId !== undefined && repository.length > 0
          ? resourceName(repository, issueId)
          : "");
      let existing = yield* getByName(name);
      if (existing === undefined) {
        existing = yield* findOwned(repository, id);
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
        return items.map((item: ssm.Issue) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const repository = expandName(
        news.repository,
        env.project,
        location,
        "repositories",
      );
      const ownership = yield* createInternalLabels(id);
      const body = encodeOwnership(ownership, news.body);
      const name =
        output?.name ??
        (news.issueId !== undefined
          ? resourceName(repository, news.issueId)
          : "");

      let current = yield* getByName(name);
      if (current === undefined) {
        current = yield* findOwned(repository, id);
      }

      if (current === undefined) {
        const created = yield* ssm
          .createProjectsLocationsRepositoriesIssues({
            parent: repository,
            body: {
              title: news.title,
              body,
            },
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
          current = yield* findOwned(repository, id);
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({
          name: name || repository,
        });
      }

      const currentName = current.name ?? name;
      const parsed = parseOwnership(current.body);
      const mask = fieldMask([
        !sameText(current.title, news.title) && "title",
        !sameText(parsed.text, news.body) && "body",
      ]);

      if (mask.length > 0) {
        const operation = yield* ssm.patchProjectsLocationsRepositoriesIssues({
          name: currentName,
          updateMask: mask,
          body: {
            etag: current.etag,
            title: news.title,
            body,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(getByName(currentName), currentName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryConflict(
        ssm
          .deleteProjectsLocationsRepositoriesIssues({
            name: output.name,
            etag: output.etag,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined))),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
