import * as servicemanagement from "@distilled.cloud/gcp/servicemanagement_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_LABEL_LENGTH = 63;
export const MAX_TITLE_LENGTH = 1024;
export const GENERATED_LABEL_LENGTH = 40;

export class OperationFailed extends Data.TaggedError(
  "GCP.Servicemanagement.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class OperationPending extends Data.TaggedError(
  "GCP.Servicemanagement.OperationPending",
)<{
  operation: string;
}> {}

export class ServiceNotResolved extends Data.TaggedError(
  "GCP.Servicemanagement.ServiceNotResolved",
)<{
  serviceName: string;
}> {}

export class ServiceStillExists extends Data.TaggedError(
  "GCP.Servicemanagement.ServiceStillExists",
)<{
  serviceName: string;
}> {}

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const encodeTitle = (
  labels: Record<string, string>,
  title: string | undefined,
): string => {
  const marker = markerOf(
    labels[alchemyLabelKeys.stack] ?? "x",
    labels[alchemyLabelKeys.stage] ?? "x",
    labels[alchemyLabelKeys.id] ?? "x",
  );
  const trimmed = title?.replace(/[\r\n]+/g, " ").trim();
  const combined = trimmed ? `${marker} ${trimmed}` : marker;
  return combined.slice(0, MAX_TITLE_LENGTH);
};

export const parseTitle = (
  title: string | undefined,
): {
  labels: Record<string, string>;
  title: string | undefined;
} => {
  if (!title?.startsWith("[alchemy ")) {
    return { labels: {}, title };
  }
  const end = title.indexOf("]");
  if (end < 0) return { labels: {}, title };
  const labels: Record<string, string> = {};
  for (const part of title.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = title.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, title: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (title: string | undefined) =>
  Object.keys(parseTitle(title).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

export const configOwnershipText = (
  config: servicemanagement.Service | undefined,
) => config?.documentation?.summary ?? config?.title;

export const ownedByAlchemy = (id: string, title: string | undefined) =>
  Effect.gen(function* () {
    const { labels } = parseTitle(title);
    if (!hasOwnershipMarker(title)) return false;
    return yield* hasAlchemyLabels(id, labels);
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const endpointsSuffix = (project: string) =>
  `.endpoints.${project}.cloud.goog`;

export const isGeneratedServiceName = (
  serviceName: string,
  project: string,
) => {
  const suffix = endpointsSuffix(project);
  return (
    serviceName.startsWith("alch-") &&
    serviceName.endsWith(suffix) &&
    serviceName.length > suffix.length
  );
};

const dnsLabel = (value: string) => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/g, "")
    .slice(0, MAX_LABEL_LENGTH)
    .replace(/-+$/g, "");
  const named = /^[a-z]/.test(cleaned) ? cleaned : `a${cleaned}`;
  return named.slice(0, MAX_LABEL_LENGTH).replace(/-+$/g, "");
};

export const toServiceName = (
  id: string,
  serviceName: string | undefined,
  existing: string | undefined,
  project: string,
) =>
  Effect.gen(function* () {
    if (serviceName !== undefined && serviceName.length > 0) {
      return serviceName;
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: GENERATED_LABEL_LENGTH,
      lowercase: true,
    });
    const label = dnsLabel(
      generated.startsWith("alch-") ? generated : `alch-${generated}`,
    );
    return `${label}${endpointsSuffix(project)}`;
  });

export const isAlreadyExists = (error: servicemanagement.Status | undefined) =>
  error?.code === 6 ||
  (error?.message ?? "").toUpperCase().includes("ALREADY_EXISTS");

export const isNotFoundStatus = (error: servicemanagement.Status | undefined) =>
  error?.code === 5 ||
  (error?.message ?? "").toLowerCase().includes("not found");

export const isRetentionMessage = (message: string | undefined) => {
  const lower = (message ?? "").toLowerCase();
  return (
    lower.includes("30 day") ||
    lower.includes("soft-delete") ||
    lower.includes("soft delete") ||
    lower.includes("already been deleted") ||
    (lower.includes("deleted") && lower.includes("cannot")) ||
    lower.includes("already exists") ||
    lower.includes("already exist")
  );
};

/** GCP returns HTTP 403 (typed Forbidden) for a missing managed service. */
export const isMissingForbidden = (message: string | undefined) =>
  (message ?? "").toLowerCase().includes("not found");

const isIgnorableOperationError = (
  error: servicemanagement.Status | undefined,
  options?: { notFoundOk?: boolean },
) =>
  isAlreadyExists(error) ||
  (options?.notFoundOk === true && isNotFoundStatus(error));

export const getByName = (serviceName: string) =>
  servicemanagement.getServices({ serviceName }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", (error) =>
      isMissingForbidden(error.message)
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

export const getLatestConfig = (serviceName: string) =>
  servicemanagement.listServicesConfigs({ serviceName, pageSize: 20 }).pipe(
    Effect.map((page) => {
      const configs = page.serviceConfigs ?? [];
      return (
        configs.find((config) =>
          hasOwnershipMarker(configOwnershipText(config)),
        ) ?? configs[0]
      );
    }),
    Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed(undefined)),
  );

export const waitForOperation = (
  operation: servicemanagement.Operation,
  options?: { notFoundOk?: boolean },
) =>
  Effect.gen(function* () {
    const name = operation.name;
    if (operation.done === true) {
      if (
        operation.error &&
        !isIgnorableOperationError(operation.error, options)
      ) {
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

    const getOperation = servicemanagement.getOperations({ name });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed({
                name,
                done: true,
              } satisfies servicemanagement.Operation),
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
        (current) =>
          !current.error || isIgnorableOperationError(current.error, options),
        (current) =>
          new OperationFailed({
            operation: name,
            message: current.error?.message ?? "operation failed",
          }),
      ),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.Servicemanagement.OperationPending",
        times: 10,
        schedule: Schedule.spaced("8 seconds"),
      }),
    );
  });

export const waitUntilExists = (serviceName: string) =>
  getByName(serviceName).pipe(
    Effect.flatMap((service) =>
      service !== undefined
        ? Effect.succeed(service)
        : Effect.fail(new ServiceNotResolved({ serviceName })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Servicemanagement.ServiceNotResolved",
      times: 10,
      schedule: Schedule.spaced("6 seconds"),
    }),
  );

export const waitUntilGone = (serviceName: string) =>
  getByName(serviceName).pipe(
    Effect.flatMap((service) =>
      service === undefined
        ? Effect.void
        : Effect.fail(new ServiceStillExists({ serviceName })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Servicemanagement.ServiceStillExists",
      times: 10,
      schedule: Schedule.spaced("4 seconds"),
    }),
  );

export const undeleteService = (serviceName: string) =>
  Effect.gen(function* () {
    const operation = yield* servicemanagement
      .undeleteServices({ serviceName })
      .pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("Forbidden", (error) =>
          isMissingForbidden(error.message)
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
        Effect.catchTag("BadRequest", (error) =>
          isRetentionMessage(error.message)
            ? Effect.succeed(undefined)
            : Effect.fail(error),
        ),
      );
    if (operation !== undefined) {
      yield* waitForOperation(operation).pipe(
        Effect.catchTag(
          "GCP.Servicemanagement.OperationPending",
          () => Effect.void,
        ),
      );
    }
    return yield* getByName(serviceName);
  });

export const listProducerServices = (project: string) =>
  servicemanagement.listServices
    .pages({
      producerProjectId: project,
      pageSize: 500,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.services ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed([] as servicemanagement.ManagedService[]),
      ),
    );
