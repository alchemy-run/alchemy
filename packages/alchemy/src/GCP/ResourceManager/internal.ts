import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const FOLDER_DISPLAY_PREFIX = "az-";
export const FOLDER_DISPLAY_MAX = 30;
export const PROJECT_ID_MIN = 6;
export const PROJECT_ID_MAX = 30;
export const PROJECT_DISPLAY_MIN = 4;
export const PROJECT_DISPLAY_MAX = 30;
export const LIEN_REASON_MAX = 200;
export const LIEN_ORIGIN_MAX = 200;
export const DEFAULT_LIEN_ORIGIN = "alchemy.effect";
export const DEFAULT_LIEN_RESTRICTIONS = [
  "resourcemanager.projects.delete",
] as const;

export class OperationFailed extends Data.TaggedError(
  "GCP.ResourceManager.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class OperationPending extends Data.TaggedError(
  "GCP.ResourceManager.OperationPending",
)<{
  operation: string;
}> {}

export class ParentRequired extends Data.TaggedError(
  "GCP.ResourceManager.ParentRequired",
)<{
  project: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const organizationParent = (value: string) =>
  value.startsWith("organizations/")
    ? value
    : `organizations/${lastSegment(value)}`;

export const folderParent = (value: string) =>
  value.startsWith("folders/") ? value : `folders/${lastSegment(value)}`;

export const projectParent = (value: string) =>
  value.startsWith("projects/") ? value : `projects/${lastSegment(value)}`;

export const normalizeHierarchyParent = (value: string) => {
  if (
    value.startsWith("organizations/") ||
    value.startsWith("folders/") ||
    value.startsWith("projects/")
  ) {
    return value;
  }
  if (value.startsWith("orgs/")) {
    return `organizations/${value.slice("orgs/".length)}`;
  }
  return folderParent(value);
};

export const sameHierarchyParent = (
  left: string | undefined,
  right: string | undefined,
) => {
  if (left === undefined || right === undefined) return left === right;
  if (left === right) return true;
  const leftKind = left.split("/")[0];
  const rightKind = right.split("/")[0];
  return leftKind === rightKind && lastSegment(left) === lastSegment(right);
};

export const isDeleteRequested = (state: string | undefined) =>
  state === "DELETE_REQUESTED";

export const alreadyExists = (error: resourcemanager.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

export const isNotFoundStatus = (error: resourcemanager.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found") ||
  (error?.message ?? "").toUpperCase().includes("PERMISSION_DENIED");

export const resourceNameFromOperation = (
  operation: resourcemanager.Operation,
  prefix: string,
): string | undefined => {
  const name = operation.response?.name;
  return typeof name === "string" && name.startsWith(prefix) ? name : undefined;
};

export const projectIdFromOperation = (
  operation: resourcemanager.Operation,
): string | undefined => {
  const projectId = operation.response?.projectId;
  return typeof projectId === "string" && projectId.length > 0
    ? projectId
    : undefined;
};

const parentOf = (name: string) =>
  name.startsWith("projects/")
    ? resourcemanager.getProjects({ name }).pipe(
        Effect.map((resource) => resource.parent),
        Effect.catchTag(["NotFound", "Forbidden"], () =>
          Effect.succeed(undefined),
        ),
      )
    : name.startsWith("folders/")
      ? resourcemanager.getFolders({ name }).pipe(
          Effect.map((folder) => folder.parent),
          Effect.catchTag(["NotFound", "Forbidden"], () =>
            Effect.succeed(undefined),
          ),
        )
      : Effect.succeed(undefined);

export const tryResolveParent = () =>
  Effect.gen(function* () {
    const folder = process.env.GOOGLE_FOLDER_ID;
    if (folder && folder.length > 0) return folderParent(folder);
    const org = process.env.GOOGLE_ORGANIZATION_ID;
    if (org && org.length > 0) return organizationParent(org);
    const env = yield* GcpEnvironment.current;
    return yield* parentOf(`projects/${env.project}`).pipe(
      Effect.map((parent) => {
        if (parent === undefined || parent.length === 0) return undefined;
        if (
          parent.startsWith("folders/") ||
          parent.startsWith("organizations/")
        ) {
          return parent;
        }
        return undefined;
      }),
    );
  });

export const resolveParent = (
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined && explicit.length > 0) {
      return normalizeHierarchyParent(explicit);
    }
    if (existing !== undefined && existing.length > 0) {
      return normalizeHierarchyParent(existing);
    }
    const resolved = yield* tryResolveParent();
    if (resolved === undefined) {
      const env = yield* GcpEnvironment.current;
      return yield* new ParentRequired({ project: env.project });
    }
    return resolved;
  });

export const projectNumberOf = (project: string) =>
  resourcemanager.getProjects({ name: `projects/${project}` }).pipe(
    Effect.map((resource) => {
      const number = lastSegment(resource.name ?? "");
      return /^\d+$/.test(number) ? number : project;
    }),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(project)),
  );

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
  maxLength: number,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  if (!description) return marker.slice(0, maxLength);
  const sep = "\n";
  const budget = maxLength - marker.length - sep.length;
  if (budget <= 0) return marker.slice(0, maxLength);
  return `${marker}${sep}${description.slice(0, budget)}`;
};

export const parseDescription = (
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

export const hasOwnershipMarker = (description: string | undefined) =>
  Object.keys(parseDescription(description).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const ownedByAlchemy = (id: string, description: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseDescription(description);
    return yield* hasAlchemyLabels(id, labels);
  });

export const createOwnership = (id: string) => createInternalLabels(id);

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  JSON.stringify(sortedStrings(left)) === JSON.stringify(sortedStrings(right));

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const waitForOperation = (
  operation: resourcemanager.Operation,
  options?: { notFoundOk?: boolean; allowAlreadyExists?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    const ignorable = (error: resourcemanager.Status | undefined) =>
      (options?.allowAlreadyExists === true && alreadyExists(error)) ||
      (options?.notFoundOk === true && isNotFoundStatus(error));

    if (operation.done === true) {
      if (operation.error && !ignorable(operation.error)) {
        return yield* new OperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new OperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = resourcemanager.getOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag(["NotFound", "Forbidden"], () =>
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
        () => new OperationPending({ operation: name }),
      ),
      Effect.filterOrFail(
        (current) => !current.error || ignorable(current.error),
        (current) =>
          new OperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) => error._tag === "GCP.ResourceManager.OperationPending",
        times: 10,
        schedule: Schedule.spaced("2 seconds"),
      }),
    );
  });
