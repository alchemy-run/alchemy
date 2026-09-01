import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  ForgejoCredentials,
  ignoreInaccessible,
  optional,
  paginate,
} from "./Client.ts";
import { listAccessibleRepositories } from "./Lists.ts";
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

interface ApiLabel {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

const collection = (props: Pick<LabelProps, "owner" | "repository">) =>
  `/repos/${encodeURIComponent(props.owner)}/${encodeURIComponent(props.repository)}/labels`;

const path = (props: Pick<LabelProps, "owner" | "repository">, id: number) =>
  `${collection(props)}/${id}`;

const bodyOf = (props: LabelProps) => ({
  name: props.name,
  color: props.color,
  description: props.description,
  exclusive: props.exclusive,
  is_archived: props.isArchived,
});

const attributesOf = (label: ApiLabel): LabelAttributes => ({
  labelId: label.id,
  name: label.name,
  color: label.color,
});

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
  const client = yield* ForgejoCredentials;
  if (labelId !== undefined) {
    const byId = yield* optional(
      client.request<ApiLabel>("GET", path(props, labelId)),
    );
    if (byId !== undefined) return byId;
  }
  const labels = yield* ignoreInaccessible(
    paginate<ApiLabel>(client, collection(props)),
    [] as readonly ApiLabel[],
  );
  return labels.find((label) => label.name === props.name);
});

/**
 * Provider layer implementing label lifecycle.
 */
export const LabelProvider = () =>
  Provider.succeed(Label, {
    stables: ["labelId"],
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (news.owner !== olds.owner || news.repository !== olds.repository)
          ? { action: "replace" as const }
          : undefined,
      ),
    list: Effect.fn(function* () {
      const client = yield* ForgejoCredentials;
      const repositories = yield* listAccessibleRepositories();
      const labels = yield* Effect.forEach(
        repositories,
        (repository) =>
          ignoreInaccessible(
            paginate<ApiLabel>(
              client,
              collection({
                owner: repository.owner.login,
                repository: repository.name,
              }),
            ),
            [] as readonly ApiLabel[],
          ),
        { concurrency: 8 },
      );
      return labels.flat().map(attributesOf);
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const observed = yield* observe(olds, output?.labelId);
      return observed === undefined ? undefined : attributesOf(observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const client = yield* ForgejoCredentials;

      // Observe: live state decides create-vs-update, so adoption and a
      // re-run after a failed state write both converge.
      const observed = yield* observe(news, output?.labelId);

      if (observed === undefined) {
        const created = yield* client.request<ApiLabel>(
          "POST",
          collection(news),
          {
            body: bodyOf(news),
          },
        );
        return attributesOf(created);
      }

      const updated = yield* client.request<ApiLabel>(
        "PATCH",
        path(news, observed.id),
        {
          body: bodyOf(news),
        },
      );
      return attributesOf(updated);
    }),
    delete: Effect.fn(function* ({ olds, output }) {
      if (output === undefined) return;
      const client = yield* ForgejoCredentials;
      yield* optional(
        client.request<void>("DELETE", path(olds, output.labelId)),
      );
    }),
  });
