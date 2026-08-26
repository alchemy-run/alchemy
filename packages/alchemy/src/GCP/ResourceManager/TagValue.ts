import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

const MAX_NAME_LENGTH = 63;
const MAX_DESCRIPTION_LENGTH = 256;

export type TagValueProps = {
  /**
   * Parent TagKey resource name (`tagKeys/{tagKey}`). Immutable —
   * changing it replaces the TagValue.
   */
  parent: string;
  /**
   * User-assigned short name, unique among TagValues of the same TagKey.
   * 1–256 characters, beginning and ending with `[a-zA-Z0-9]`, with
   * dashes, underscores, dots, and alphanumerics between. If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the TagValue.
   */
  shortName?: string;
  /**
   * Human-readable description (max 256 characters). TagValues have no
   * labels field, so Alchemy ownership (`alchemy-stack` / `alchemy-stage`
   * / `alchemy-id`) is stored in a `[alchemy …]` prefix for `list` / nuke
   * and stripped from attributes.
   */
  description?: string;
};

export type TagValue = Resource<
  "GCP.ResourceManager.TagValue",
  TagValueProps,
  {
    /** Resource name `tagValues/{tagValue}`. */
    name: string;
    /** Parent TagKey name `tagKeys/{tagKey}`. */
    parent: string;
    /** User-assigned short name. */
    shortName: string;
    /**
     * Namespaced name `{project}/{tagKeyShort}/{tagValueShort}` (or the
     * organization-id form).
     */
    namespacedName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Project id of the deploying stack. */
    project: string;
    /** Optimistic-concurrency etag. */
    etag: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Resource Manager TagValue — a child of a TagKey used to group
 * resources for policy.
 *
 * TagValues have no labels field, so Alchemy stamps ownership into the
 * description for `list` / nuke. `parent` and `shortName` are identity —
 * changing either replaces the value. Description updates in place.
 * Create, update, and delete are long-running operations polled via
 * `getOperations`.
 *
 * ### Creating a TagValue
 * **Example:** Generated short name under a TagKey
 * ```typescript
 * const key = yield* GCP.ResourceManager.TagKey("Environment", {});
 * const value = yield* GCP.ResourceManager.TagValue("Prod", {
 *   parent: key.name,
 *   description: "production",
 * });
 * ```
 *
 * **Example:** Explicit short name
 * ```typescript
 * const value = yield* GCP.ResourceManager.TagValue("Prod", {
 *   parent: "tagKeys/123456789012",
 *   shortName: "prod",
 *   description: "production",
 * });
 * ```
 *
 * ### Updating a TagValue
 * **Example:** Change the description
 * ```typescript
 * const value = yield* GCP.ResourceManager.TagValue("Prod", {
 *   parent: "tagKeys/123456789012",
 *   shortName: "prod",
 *   description: "production workloads",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ResourceManager
 */
export const TagValue = Resource<TagValue>("GCP.ResourceManager.TagValue");

export class TagValueNotResolved extends Data.TaggedError(
  "GCP.ResourceManager.TagValueNotResolved",
)<{
  name: string;
}> {}

export class TagValueParentRequired extends Data.TaggedError(
  "GCP.ResourceManager.TagValueParentRequired",
)<{
  parent: string;
}> {}

export class TagValueOperationFailed extends Data.TaggedError(
  "GCP.ResourceManager.TagValueOperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class TagValueOperationPending extends Data.TaggedError(
  "GCP.ResourceManager.TagValueOperationPending",
)<{
  operation: string;
}> {}

export class TagValueStillExists extends Data.TaggedError(
  "GCP.ResourceManager.TagValueStillExists",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeParent = (parent: string): string => {
  const trimmed = parent.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("tagKeys/")) return trimmed;
  if (/^\d+$/.test(trimmed)) return `tagKeys/${trimmed}`;
  return trimmed;
};

const toShortName = (
  id: string,
  shortName: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (shortName !== undefined) return shortName;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
    const named = /^[a-z]/.test(generated) ? generated : `t${generated}`;
    return named.replace(/-+$/g, "").slice(0, MAX_NAME_LENGTH);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  if (!description) return marker.slice(0, MAX_DESCRIPTION_LENGTH);
  const budget = MAX_DESCRIPTION_LENGTH - marker.length - 1;
  if (budget <= 0) return marker.slice(0, MAX_DESCRIPTION_LENGTH);
  return `${marker}\n${description.slice(0, budget)}`;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const toAttrs = (
  value: crm.TagValue,
  project: string,
): TagValue["Attributes"] => {
  const parsed = parseDescription(value.description);
  return {
    name: value.name ?? "",
    parent: value.parent ?? "",
    shortName: value.shortName ?? lastSegment(value.namespacedName ?? ""),
    namespacedName: value.namespacedName,
    description: parsed.description,
    project,
    etag: value.etag,
    createTime: value.createTime,
    updateTime: value.updateTime,
  };
};

const getByName = (name: string) =>
  crm
    .getTagValues({ name })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed(undefined),
      ),
    );

const listTagValuesUnder = (parent: string) =>
  Effect.gen(function* () {
    const found: crm.TagValue[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* crm.listTagValues({
        parent,
        pageSize: 300,
        pageToken,
      });
      found.push(...(response.tagValues ?? []));
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  }).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as crm.TagValue[]),
    ),
  );

const listTagKeysUnder = (parent: string) =>
  Effect.gen(function* () {
    const found: crm.TagKey[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = yield* crm.listTagKeys({
        parent,
        pageSize: 300,
        pageToken,
      });
      found.push(...(response.tagKeys ?? []));
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") break;
    }
    return found;
  }).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as crm.TagKey[]),
    ),
  );

const findByParentAndShortName = (parent: string, shortName: string) =>
  listTagValuesUnder(parent).pipe(
    Effect.map((values) =>
      values.find((value) => value.shortName === shortName),
    ),
  );

const observe = (
  name: string | undefined,
  parent: string | undefined,
  shortName: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    if (parent !== undefined && parent.length > 0) {
      return yield* findByParentAndShortName(parent, shortName);
    }
    return undefined;
  });

const isAlreadyExists = (error: crm.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

const isNotFoundStatus = (error: crm.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

const isIgnorableOperationError = (
  error: crm.Status | undefined,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  (options?.alreadyExistsOk === true && isAlreadyExists(error)) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

const nameFromOperation = (operation: crm.Operation): string | undefined => {
  const name = operation.response?.name;
  return typeof name === "string" && name.startsWith("tagValues/")
    ? name
    : undefined;
};

const waitForOperation = (
  operation: crm.Operation,
  options?: { notFoundOk?: boolean; alreadyExistsOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (
        operation.error &&
        !isIgnorableOperationError(operation.error, options)
      ) {
        return yield* new TagValueOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      return yield* new TagValueOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = crm.getOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies crm.Operation),
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
        () => new TagValueOperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) =>
          !current.error || isIgnorableOperationError(current.error, options),
        (current) =>
          new TagValueOperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.ResourceManager.TagValueOperationPending",
        times: 10,
        schedule: Schedule.spaced("2 seconds"),
      }),
    );
  });

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((value) =>
      value
        ? Effect.succeed(value)
        : Effect.fail(new TagValueNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ResourceManager.TagValueNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilFound = (parent: string, shortName: string) =>
  findByParentAndShortName(parent, shortName).pipe(
    Effect.flatMap((value) =>
      value !== undefined
        ? Effect.succeed(value)
        : Effect.fail(
            new TagValueNotResolved({ name: `${parent}/${shortName}` }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ResourceManager.TagValueNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((value) =>
      value === undefined
        ? Effect.void
        : Effect.fail(new TagValueStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.ResourceManager.TagValueStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
    Effect.catchTag(
      "GCP.ResourceManager.TagValueStillExists",
      () => Effect.void,
    ),
  );

const requireParent = (parent: string) => {
  const normalized = normalizeParent(parent);
  if (!normalized.startsWith("tagKeys/") || lastSegment(normalized) === "") {
    return Effect.fail(new TagValueParentRequired({ parent }));
  }
  return Effect.succeed(normalized);
};

export const TagValueProvider = () =>
  Provider.succeed(TagValue, {
    stables: [
      "name",
      "parent",
      "shortName",
      "namespacedName",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      const nextParent = news.parent ?? previousParent;
      const parentChanged =
        previousParent !== undefined &&
        nextParent !== undefined &&
        normalizeParent(previousParent) !== normalizeParent(nextParent);

      const previousShort = olds?.shortName ?? output?.shortName;
      const nextShort = news.shortName ?? previousShort;
      const shortChanged =
        previousShort !== undefined &&
        nextShort !== undefined &&
        nextShort !== previousShort;

      if (parentChanged || shortChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent =
        olds?.parent !== undefined
          ? normalizeParent(olds.parent)
          : output?.parent;
      const shortName = yield* toShortName(
        id,
        olds?.shortName,
        output?.shortName,
      );
      const existing = yield* observe(output?.name, parent, shortName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const keys = yield* listTagKeysUnder(`projects/${env.project}`);
        const values: TagValue["Attributes"][] = [];
        for (const key of keys) {
          if (key.name === undefined || key.name.length === 0) continue;
          const children = yield* listTagValuesUnder(key.name);
          for (const value of children) {
            if (hasOwnershipMarker(value.description)) {
              values.push(toAttrs(value, env.project));
            }
          }
        }
        return values;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = yield* requireParent(news.parent);
      const shortName = yield* toShortName(
        id,
        news.shortName,
        output?.shortName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);

      let current = yield* observe(output?.name, parent, shortName);

      if (current === undefined) {
        const operation = yield* crm
          .createTagValues({
            body: {
              parent,
              shortName,
              description: desiredDescription,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (operation !== undefined) {
          const done = yield* waitForOperation(operation, {
            alreadyExistsOk: true,
          });
          const createdName = nameFromOperation(done);
          if (createdName !== undefined) {
            current = yield* waitUntilExists(createdName).pipe(
              Effect.catchTag("GCP.ResourceManager.TagValueNotResolved", () =>
                Effect.succeed(undefined),
              ),
            );
          }
        }
        if (current === undefined) {
          current = yield* waitUntilFound(parent, shortName);
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new TagValueNotResolved({
          name: `${parent}/${shortName}`,
        });
      }

      if ((current.description ?? "") !== desiredDescription) {
        const patched = yield* crm.patchTagValues({
          name: current.name,
          updateMask: "description",
          body: {
            name: current.name,
            description: desiredDescription,
            etag: current.etag,
          },
        });
        const done = yield* waitForOperation(patched);
        const patchedName = nameFromOperation(done) ?? current.name;
        current = yield* waitUntilExists(patchedName);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* crm
        .deleteTagValues({ name: output.name, etag: output.etag })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed(undefined),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
