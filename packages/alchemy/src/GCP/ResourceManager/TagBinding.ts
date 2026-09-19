import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import type { GcpOpContext } from "@distilled.cloud/gcp/Protocol";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

const CRM_PREFIX = "//cloudresourcemanager.googleapis.com/";
const PROJECT_PARENT =
  /^\/\/cloudresourcemanager\.googleapis\.com\/projects\/([^/]+)$/;

export type TagBindingProps = {
  /**
   * Full resource name of the resource to bind the TagValue to, e.g.
   * `//cloudresourcemanager.googleapis.com/projects/{project}`. Accepts
   * `projects/{project}`, `folders/{folder}`, or `organizations/{org}`
   * and expands them. If omitted, the current project is used (as a
   * project-number full name). Immutable — changing it replaces the
   * binding.
   */
  parent?: string;
  /**
   * TagValue to bind. Accepts `tagValues/{id}` or the namespaced name
   * `{parent}/{tag-key}/{tag-value}`. Immutable — changing it replaces
   * the binding.
   */
  tagValue: string;
};

export type TagBinding = Resource<
  "GCP.ResourceManager.TagBinding",
  TagBindingProps,
  {
    /**
     * Resource name
     * `tagBindings/{full-resource-name}/{tag-value-name}`.
     */
    name: string;
    /** Full resource name of the bound resource. */
    parent: string;
    /** TagValue resource name `tagValues/{id}`. */
    tagValue: string;
    /**
     * Namespaced TagValue
     * (`{parent}/{tag-key-short-name}/{tag-value-short-name}`).
     */
    tagValueNamespacedName: string | undefined;
    /** Project id used to default `parent`. */
    project: string;
  },
  never,
  Providers
>;

/**
 * A Resource Manager TagBinding — a connection between a TagValue and a
 * Google Cloud resource (project, folder, or organization). Creating the
 * binding applies the TagValue to the resource and its descendants.
 *
 * TagBindings have no labels and no update API. Identity is
 * `(parent, tagValue)`; changing either replaces the binding
 * (delete-first, because a resource may only hold one value per TagKey).
 * `list` / `pnpm nuke:gcp` enumerates bindings whose parent is the
 * current project and whose TagValue belongs to a project-parented
 * TagKey.
 *
 * ### Creating a Tag Binding
 * **Example:** Bind a TagValue to the current project
 * ```typescript
 * const binding = yield* GCP.ResourceManager.TagBinding("Env", {
 *   tagValue: "tagValues/456",
 * });
 * ```
 *
 * **Example:** Explicit parent and namespaced TagValue
 * ```typescript
 * const binding = yield* GCP.ResourceManager.TagBinding("Env", {
 *   parent: "//cloudresourcemanager.googleapis.com/projects/123456789",
 *   tagValue: "my-project/environment/prod",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ResourceManager
 */
export const TagBinding = Resource<TagBinding>(
  "GCP.ResourceManager.TagBinding",
);

export class TagBindingNotResolved extends Data.TaggedError(
  "GCP.ResourceManager.TagBindingNotResolved",
)<{
  parent: string;
  tagValue: string;
}> {}

export class TagBindingOperationFailed extends Data.TaggedError(
  "GCP.ResourceManager.TagBindingOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class TagBindingOperationPending extends Data.TaggedError(
  "GCP.ResourceManager.TagBindingOperationPending",
)<{
  operation: string;
}> {}

export class TagBindingStillExists extends Data.TaggedError(
  "GCP.ResourceManager.TagBindingStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const unique = (values: string[]) => [
  ...new Set(values.filter((value) => value.length > 0)),
];

const hasAlchemyDescription = (description: string | undefined) =>
  (description ?? "").includes("[alchemy ");

const expandParent = (
  parent: string | undefined,
  project: string,
  projectNumber: string,
) => {
  if (parent === undefined || parent.length === 0) {
    return `${CRM_PREFIX}projects/${projectNumber || project}`;
  }
  if (parent.startsWith("//")) return parent;
  if (
    parent.startsWith("projects/") ||
    parent.startsWith("folders/") ||
    parent.startsWith("organizations/")
  ) {
    return `${CRM_PREFIX}${parent}`;
  }
  return parent;
};

const isProjectParent = (parent: string) => PROJECT_PARENT.test(parent);

const projectAliases = (
  parent: string,
  project: string,
  projectNumber: string,
) => {
  const expanded = expandParent(parent, project, projectNumber);
  if (!isProjectParent(expanded)) return [expanded];
  return unique([
    expanded,
    `${CRM_PREFIX}projects/${project}`,
    `${CRM_PREFIX}projects/${projectNumber}`,
  ]);
};

const sameParent = (
  left: string,
  right: string,
  project: string,
  projectNumber: string,
) => {
  const aliases = new Set(projectAliases(left, project, projectNumber));
  return projectAliases(right, project, projectNumber).some((alias) =>
    aliases.has(alias),
  );
};

const sameTagValue = (binding: resourcemanager.TagBinding, desired: string) =>
  desired === (binding.tagValue ?? "") ||
  desired === (binding.tagValueNamespacedName ?? "");

const toAttrs = (binding: resourcemanager.TagBinding, project: string) => ({
  name: binding.name ?? "",
  parent: binding.parent ?? "",
  tagValue: binding.tagValue ?? "",
  tagValueNamespacedName: binding.tagValueNamespacedName,
  project,
});

const isTagValueId = (tagValue: string) => tagValue.startsWith("tagValues/");

const createBody = (
  parent: string,
  tagValue: string,
): resourcemanager.TagBinding =>
  isTagValueId(tagValue)
    ? { parent, tagValue }
    : { parent, tagValueNamespacedName: tagValue };

const parseBindingName = (name: string) => {
  if (!name.startsWith("tagBindings/")) {
    return {
      parent: undefined as string | undefined,
      tagValue: undefined as string | undefined,
    };
  }
  const rest = name.slice("tagBindings/".length);
  const tagValuesAt = rest.lastIndexOf("/tagValues/");
  const tagKeysAt = rest.lastIndexOf("/tagKeys/");
  const at = tagValuesAt >= 0 ? tagValuesAt : tagKeysAt;
  if (at < 0) {
    return {
      parent: undefined as string | undefined,
      tagValue: undefined as string | undefined,
    };
  }
  return {
    parent: decodeURIComponent(rest.slice(0, at)),
    tagValue: rest.slice(at + 1),
  };
};

const bindingNameOf = (parent: string, tagValue: string) =>
  `tagBindings/${encodeURIComponent(parent)}/${tagValue}`;

const projectNumberOf = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) => {
      const number = lastSegment(resource.name ?? "");
      return /^\d+$/.test(number) ? number : project;
    }),
    Effect.catchTag("NotFound", () => Effect.succeed(project)),
    Effect.catchTag("Forbidden", () => Effect.succeed(project)),
  );

const listBindings = (parent: string) =>
  resourcemanager.listTagBindings.pages({ parent, pageSize: 300 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.tagBindings ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as resourcemanager.TagBinding[]),
    ),
    Effect.catchTag("Forbidden", () =>
      Effect.succeed([] as resourcemanager.TagBinding[]),
    ),
  );

const listBindingsOn = (parents: string[]) =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(parents, listBindings, {
      concurrency: 2,
    });
    const byName = new Map<string, resourcemanager.TagBinding>();
    for (const binding of pages.flat()) {
      const name = binding.name;
      if (name) byName.set(name, binding);
    }
    return [...byName.values()];
  });

const listTagKeys = (parent: string) =>
  resourcemanager.listTagKeys.pages({ parent, pageSize: 300 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.tagKeys ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as resourcemanager.TagKey[]),
    ),
    Effect.catchTag("Forbidden", () =>
      Effect.succeed([] as resourcemanager.TagKey[]),
    ),
  );

const listTagValues = (parent: string) =>
  resourcemanager.listTagValues.pages({ parent, pageSize: 300 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.tagValues ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () =>
      Effect.succeed([] as resourcemanager.TagValue[]),
    ),
    Effect.catchTag("Forbidden", () =>
      Effect.succeed([] as resourcemanager.TagValue[]),
    ),
  );

const projectTagValueIds = (project: string, projectNumber: string) =>
  Effect.gen(function* () {
    const parents = unique([
      `projects/${project}`,
      `projects/${projectNumber}`,
    ]);
    const keys = (yield* Effect.forEach(parents, listTagKeys, {
      concurrency: 2,
    })).flat();
    const byName = new Map<string, resourcemanager.TagKey>();
    for (const key of keys) {
      if (key.name && hasAlchemyDescription(key.description)) {
        byName.set(key.name, key);
      }
    }
    const values = yield* Effect.forEach(
      [...byName.values()],
      (key) =>
        key.name
          ? listTagValues(key.name)
          : Effect.succeed([] as resourcemanager.TagValue[]),
      { concurrency: 4 },
    );
    const ids = new Set<string>();
    for (const value of values.flat()) {
      if (!hasAlchemyDescription(value.description)) continue;
      if (value.name) ids.add(value.name);
      if (value.namespacedName) ids.add(value.namespacedName);
    }
    return ids;
  });

const findBinding = (
  parent: string,
  tagValue: string | undefined,
  name: string | undefined,
  project: string,
  projectNumber: string,
) =>
  Effect.gen(function* () {
    const parsed = name ? parseBindingName(name) : undefined;
    const parents = projectAliases(
      parent || parsed?.parent || "",
      project,
      projectNumber,
    );
    const bindings = yield* listBindingsOn(parents);
    const desired = tagValue || parsed?.tagValue;
    if (desired !== undefined && desired.length > 0) {
      const byValue = bindings.find((binding) =>
        sameTagValue(binding, desired),
      );
      if (byValue) return byValue;
    }
    if (name) {
      return bindings.find((binding) => binding.name === name);
    }
    return undefined;
  });

const alreadyExists = (error: resourcemanager.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: resourcemanager.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toUpperCase().includes("NOT_FOUND");

const waitForOperation = (
  operation: resourcemanager.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (alreadyExists(operation.error)) {
          return operation;
        }
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new TagBindingOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) {
        return operation;
      }
      return yield* new TagBindingOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = resourcemanager.getOperations({ name });
    const resolved: Effect.Effect<
      resourcemanager.Operation,
      resourcemanager.GetOperationsError,
      GcpOpContext
    > =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies resourcemanager.Operation),
            ),
          )
        : getOperation.pipe(
            Effect.retry({
              while: (error) => error._tag === "NotFound",
              times: 5,
              schedule: Schedule.exponential("250 millis"),
            }),
          );

    return yield* resolved.pipe(
      Effect.filterOrFail(
        (current) => current.done === true,
        () => new TagBindingOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (!error || alreadyExists(error)) {
          return Effect.succeed(current);
        }
        if (options?.notFoundOk === true && isNotFoundStatus(error)) {
          return Effect.succeed(current);
        }
        return Effect.fail(
          new TagBindingOperationFailed({
            operation: name,
            message: error.message ?? "operation failed",
          }),
        );
      }),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.ResourceManager.TagBindingOperationPending",
        times: 10,
        schedule: Schedule.spaced("2 seconds"),
      }),
    );
  });

const waitUntilExists = (
  parent: string,
  tagValue: string,
  project: string,
  projectNumber: string,
  name?: string,
) =>
  findBinding(parent, tagValue, name, project, projectNumber).pipe(
    Effect.flatMap((binding) =>
      binding
        ? Effect.succeed(binding)
        : Effect.fail(new TagBindingNotResolved({ parent, tagValue })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ResourceManager.TagBindingNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (
  parent: string,
  tagValue: string,
  project: string,
  projectNumber: string,
  name?: string,
) =>
  findBinding(parent, tagValue, name, project, projectNumber).pipe(
    Effect.flatMap((binding) =>
      binding === undefined
        ? Effect.void
        : Effect.fail(
            new TagBindingStillExists({
              name: binding.name ?? name ?? "",
            }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ResourceManager.TagBindingStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const TagBindingProvider = () =>
  Provider.succeed(TagBinding, {
    stables: ["name", "parent", "tagValue", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const projectNumber = yield* projectNumberOf(env.project);
      const previousParent = olds?.parent ?? output?.parent;
      const nextParent = expandParent(
        news.parent ?? previousParent,
        env.project,
        projectNumber,
      );
      const parentChanged =
        previousParent !== undefined &&
        !sameParent(previousParent, nextParent, env.project, projectNumber);

      const previousValue = olds?.tagValue ?? output?.tagValue;
      const previousNs = output?.tagValueNamespacedName;
      const tagValueChanged =
        previousValue !== undefined &&
        news.tagValue !== previousValue &&
        news.tagValue !== previousNs;

      if (!parentChanged && !tagValueChanged) return undefined;
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const projectNumber = yield* projectNumberOf(env.project);
      const parsed = output?.name ? parseBindingName(output.name) : undefined;
      const parent = expandParent(
        output?.parent ?? olds?.parent ?? parsed?.parent,
        env.project,
        projectNumber,
      );
      const tagValue = output?.tagValue ?? olds?.tagValue ?? parsed?.tagValue;
      if (!parent && !tagValue && !output?.name) return undefined;
      const existing = yield* findBinding(
        parent,
        tagValue,
        output?.name,
        env.project,
        projectNumber,
      );
      if (existing === undefined) return undefined;
      // TagBindings have no labels; identity (parent + tagValue) is ownership.
      return toAttrs(existing, env.project);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const projectNumber = yield* projectNumberOf(env.project);
        const ownedValues = yield* projectTagValueIds(
          env.project,
          projectNumber,
        );
        if (ownedValues.size === 0) return [];
        const bindings = yield* listBindingsOn(
          projectAliases(
            `${CRM_PREFIX}projects/${projectNumber}`,
            env.project,
            projectNumber,
          ),
        );
        return bindings
          .filter(
            (binding) =>
              ownedValues.has(binding.tagValue ?? "") ||
              ownedValues.has(binding.tagValueNamespacedName ?? ""),
          )
          .map((binding) => toAttrs(binding, env.project));
      }),

    reconcile: Effect.fn(function* ({ news }) {
      const env = yield* GcpEnvironment.current;
      const projectNumber = yield* projectNumberOf(env.project);
      const parent = expandParent(news.parent, env.project, projectNumber);
      const tagValue = news.tagValue;

      let current = yield* findBinding(
        parent,
        tagValue,
        undefined,
        env.project,
        projectNumber,
      );

      if (current === undefined) {
        const created = yield* resourcemanager
          .createTagBindings({
            body: createBody(parent, tagValue),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(
          parent,
          tagValue,
          env.project,
          projectNumber,
        );
      }

      if (current === undefined) {
        return yield* new TagBindingNotResolved({ parent, tagValue });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const projectNumber = yield* projectNumberOf(env.project);
      const parsed = parseBindingName(output.name);
      const parent = expandParent(
        output.parent || parsed.parent,
        env.project,
        projectNumber,
      );
      const tagValue = output.tagValue || parsed.tagValue || "";
      let name = output.name;
      if (!name) {
        const existing = yield* findBinding(
          parent,
          tagValue,
          undefined,
          env.project,
          projectNumber,
        );
        name = existing?.name ?? "";
      }
      if (!name && parent && isTagValueId(tagValue)) {
        name = bindingNameOf(parent, tagValue);
      }
      if (!name) return;

      const operation = yield* resourcemanager
        .deleteTagBindings({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(parent, tagValue, env.project, projectNumber, name);
    }),
  });
