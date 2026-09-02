import { Services } from "@distilled.cloud/forgejo";
import type { Label as ApiLabel } from "@distilled.cloud/forgejo/issue";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { listAccessibleRepositories } from "./Lists.ts";
import { paginate } from "./Pagination.ts";
import { matchesDesired } from "./Settings.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Desired repository issue and pull-request label.
 */
export interface LabelProps {
  /**
   * Repository owner.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
  /**
   * Label name.
   */
  readonly name: string;
  /**
   * Hex label color without `#`.
   */
  readonly color: string;
  /**
   * Label description.
   */
  readonly description?: string;
  /**
   * Mark as exclusive.
   */
  readonly exclusive?: boolean;
  /**
   * Archive the label.
   */
  readonly isArchived?: boolean;
}

/**
 * Observed repository label attributes.
 */
export interface LabelAttributes {
  /**
   * Stable numeric label ID.
   */
  readonly labelId: number;
  /**
   * Repository owner. Carried on the attributes so account-wide teardown,
   * which has no state row to read props from, can still address the label.
   */
  readonly owner: string;
  /**
   * Repository name.
   */
  readonly repository: string;
  /**
   * Label name.
   */
  readonly name: string;
  /**
   * Label color.
   */
  readonly color: string;
}

/**
 * A Forgejo repository label resource, usable by issues and pull requests.
 */
export interface Label extends Resource<
  "Forgejo.Label",
  LabelProps,
  LabelAttributes,
  never,
  Forgejo.Providers
> {}

/**
 * An issue and pull-request label on a Forgejo repository.
 *
 * A label that already exists under the same name is adopted rather than
 * duplicated, so importing a repository's existing labels is safe.
 *
 * ### Creating a Label
 * **Example:** Basic Label
 * ```typescript
 * yield* Forgejo.Label("bug", {
 *   owner: "acme",
 *   repository: "api",
 *   name: "bug",
 *   color: "d73a4a",
 * });
 * ```
 *
 * **Example:** Exclusive Label
 * ```typescript
 * yield* Forgejo.Label("priority-high", {
 *   owner: "acme",
 *   repository: "api",
 *   name: "priority/high",
 *   color: "b60205",
 *   description: "Drop everything",
 *   exclusive: true,
 * });
 * ```
 *
 * @resource
 */
export const Label = Resource<Label>("Forgejo.Label");

const target = (props: Pick<LabelProps, "owner" | "repository">) => ({
  owner: props.owner,
  repo: props.repository,
});

const bodyOf = (props: LabelProps) => ({
  name: props.name,
  color: props.color,
  description: props.description,
  exclusive: props.exclusive,
  is_archived: props.isArchived,
});

const attributesOf = (
  props: Pick<LabelProps, "owner" | "repository">,
  label: ApiLabel,
): LabelAttributes => ({
  labelId: label.id,
  owner: props.owner,
  repository: props.repository,
  name: label.name,
  color: label.color,
});

/**
 * Every label of a repository, or none when the credential cannot read the
 * repository: account-wide enumeration walks repositories the credential
 * may not be able to inspect, and a single inaccessible one must not abort
 * the whole sweep.
 */
const listLabels = (props: Pick<LabelProps, "owner" | "repository">) =>
  paginate(Services.issue.issueListLabels, target(props)).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as readonly ApiLabel[]),
    ),
  );

/**
 * Locate the live label, by ID when one is already known and otherwise by
 * name within the repository. The name lookup is what lets an existing label
 * be adopted, and what makes a re-run after a partially-persisted create
 * converge instead of creating a duplicate.
 */
const observe = Effect.fn(function* (
  props: Pick<LabelProps, "owner" | "repository" | "name">,
  labelId: number | undefined,
) {
  if (labelId !== undefined) {
    const byId = yield* Services.issue
      .issueGetLabel({ ...target(props), id: labelId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    if (byId !== undefined) return byId;
  }
  const labels = yield* listLabels(props);
  return labels.find((label) => label.name === props.name);
});

/**
 * Provider layer implementing label lifecycle.
 */
export const LabelProvider = () =>
  Provider.succeed(Label, {
    stables: ["labelId", "owner", "repository"],
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (news.owner !== olds.owner || news.repository !== olds.repository)
          ? { action: "replace" as const }
          : undefined,
      ),
    list: Effect.fn(function* () {
      const repositories = yield* listAccessibleRepositories();
      const labels = yield* Effect.forEach(
        repositories,
        (repository) => {
          const props = {
            owner: repository.owner.login,
            repository: repository.name,
          };
          return listLabels(props).pipe(
            Effect.map((found) =>
              found.map((label) => attributesOf(props, label)),
            ),
          );
        },
        { concurrency: 8 },
      );
      return labels.flat();
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(olds, output?.labelId);
      return observed === undefined ? undefined : attributesOf(olds, observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      // Observe: live state decides create-vs-update, so adoption and a
      // re-run after a failed state write both converge.
      const observed = yield* observe(news, output?.labelId);

      if (observed === undefined) {
        const created = yield* Services.issue.issueCreateLabel({
          ...target(news),
          ...bodyOf(news),
        });
        return attributesOf(news, created);
      }

      // Sync only when the live label differs from what was declared.
      const desired = bodyOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* Services.issue.issueEditLabel({
            ...target(news),
            id: observed.id,
            ...desired,
          });
      return attributesOf(news, updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      if (output === undefined) return;
      // Address the label from `output` alone: account-wide teardown has no
      // state row, so it passes the Attributes shape as `olds` too.
      yield* Services.issue
        .issueDeleteLabel({ ...target(output), id: output.labelId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
