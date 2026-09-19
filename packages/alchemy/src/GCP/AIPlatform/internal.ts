import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { tagRecord } from "../../Tags.ts";
import { alchemyLabelKeys, stripInternalLabels } from "../Labels.ts";

export const DEFAULT_LOCATION = "us-central1";
export const MAX_NAME_LENGTH = 63;

export const DEFAULT_TABULAR_METADATA_SCHEMA_URI =
  "gs://google-cloud-aiplatform/schema/dataset/metadata/tabular_1.0.0.yaml";

export class AIPlatformOperationFailed extends Data.TaggedError(
  "GCP.AIPlatform.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class AIPlatformOperationPending extends Data.TaggedError(
  "GCP.AIPlatform.OperationPending",
)<{
  operation: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `a${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return "resource";
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const normalizeLocation = (location: string | undefined) =>
  lastSegment(location ?? DEFAULT_LOCATION).toLowerCase();

export const parentOf = (project: string, location: string) =>
  `projects/${project}/locations/${location}`;

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const stringMapOf = (
  map: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[1].length > 0,
    ),
  );

export const hasAlchemyLabelKeys = (
  labels: Record<string, string | undefined> | null | undefined,
) => Object.keys(labels ?? {}).some((key) => key.startsWith("alchemy-"));

export const parseResourceName = (name: string, collection: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const collectionAt = parts.lastIndexOf(collection);
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : DEFAULT_LOCATION,
    id:
      collectionAt >= 0 && parts[collectionAt + 1]
        ? parts[collectionAt + 1]!
        : lastSegment(name),
  };
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  separator: "\n" | " " = "\n",
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0
    ? `${marker}${separator}${trimmed}`
    : marker;
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const alreadyExists = (error: aiplatform.GoogleRpcStatus | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toLowerCase().includes("already exists");

const isNotFoundStatus = (error: aiplatform.GoogleRpcStatus | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

export const resourceNameFromOperation = (
  operation: aiplatform.GoogleLongrunningOperation,
): string | undefined => {
  const response = operation.response;
  if (response && typeof response === "object" && "name" in response) {
    const name = (response as { name?: unknown }).name;
    if (typeof name === "string" && name.length > 0) return name;
  }
  return undefined;
};

export const waitForOperation = (
  operation: aiplatform.GoogleLongrunningOperation,
  options?: {
    notFoundOk?: boolean;
    times?: number;
    space?: `${number} seconds`;
  },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (operation.error) {
        if (alreadyExists(operation.error)) return operation;
        if (options?.notFoundOk === true && isNotFoundStatus(operation.error)) {
          return operation;
        }
        return yield* new AIPlatformOperationFailed({
          operation: name ?? "",
          message: operation.error.message ?? "operation failed",
        });
      }
      return operation;
    }
    if (name === undefined || name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new AIPlatformOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = aiplatform.getProjectsLocationsOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<aiplatform.GoogleLongrunningOperation>({
                name,
                done: true,
              }),
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
        () => new AIPlatformOperationPending({ operation: name }),
      ),
      Effect.flatMap((current) => {
        const error = current.error;
        if (!error) return Effect.succeed(current);
        if (alreadyExists(error)) return Effect.succeed(current);
        if (options?.notFoundOk === true && isNotFoundStatus(error)) {
          return Effect.succeed(current);
        }
        return Effect.fail(
          new AIPlatformOperationFailed({
            operation: name,
            message: error.message ?? "operation failed",
          }),
        );
      }),
      Effect.retry({
        while: (error) => error._tag === "GCP.AIPlatform.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced(options?.space ?? "4 seconds"),
      }),
    );
  });

export const JOB_TERMINAL_STATES = new Set([
  "JOB_STATE_SUCCEEDED",
  "JOB_STATE_FAILED",
  "JOB_STATE_CANCELLED",
  "JOB_STATE_EXPIRED",
  "JOB_STATE_PARTIALLY_SUCCEEDED",
]);

export const isJobTerminal = (state: string | undefined) =>
  state !== undefined && JOB_TERMINAL_STATES.has(state);
