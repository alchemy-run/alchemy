import * as deploymentmanager from "@distilled.cloud/gcp/deploymentmanager_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import { stripInternalLabels } from "../Labels.ts";

export const MAX_NAME_LENGTH = 63;

export class DeploymentmanagerOperationFailed extends Data.TaggedError(
  "GCP.Deploymentmanager.OperationFailed",
)<{
  operation: string;
  message: string;
}> {}

export class DeploymentmanagerOperationPending extends Data.TaggedError(
  "GCP.Deploymentmanager.OperationPending",
)<{
  operation: string;
  status: string | undefined;
}> {}

export class ResourceNotResolved extends Data.TaggedError(
  "GCP.Deploymentmanager.ResourceNotResolved",
)<{
  name: string;
}> {}

export class ResourceStillExists extends Data.TaggedError(
  "GCP.Deploymentmanager.ResourceStillExists",
)<{
  name: string;
}> {}

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const rfc1035 = (name: string, fallback = "deployment"): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(next)) next = `d${next}`;
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, "");
  if (next.length === 0) return fallback;
  if (!/[a-z0-9]$/.test(next)) next = `${next.slice(0, MAX_NAME_LENGTH - 1)}0`;
  return next.slice(0, MAX_NAME_LENGTH);
};

export const toPhysicalId = (
  id: string,
  explicit: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (explicit !== undefined) return rfc1035(explicit);
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
    );
  });

export const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

export const labelsToRecord = (
  labels: readonly deploymentmanager.DeploymentLabelEntry[] | undefined,
): Record<string, string> =>
  Object.fromEntries(
    (labels ?? [])
      .filter(
        (entry): entry is { key: string; value: string } =>
          typeof entry.key === "string" &&
          entry.key.length > 0 &&
          typeof entry.value === "string",
      )
      .map((entry) => [entry.key, entry.value]),
  );

export const recordToLabels = (
  labels: Record<string, string>,
): deploymentmanager.DeploymentLabelEntry[] =>
  Object.entries(labels).map(([key, value]) => ({ key, value }));

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonical).filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, canonical(item)] as const)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return undefined;
    return Object.fromEntries(entries);
  }
  return undefined;
};

export const fingerprint = (value: unknown): string =>
  JSON.stringify(canonical(value) ?? null);

const alreadyExists = (operation: deploymentmanager.Operation) =>
  (operation.error?.errors ?? []).some((error) => {
    const code = (error.code ?? "").toUpperCase();
    const message = (error.message ?? "").toUpperCase();
    return (
      code.includes("ALREADY_EXISTS") || message.includes("ALREADY_EXISTS")
    );
  });

const notFoundError = (operation: deploymentmanager.Operation) =>
  (operation.error?.errors ?? []).some((error) => {
    const code = (error.code ?? "").toUpperCase();
    const message = (error.message ?? "").toLowerCase();
    return (
      code === "NOT_FOUND" ||
      code === "RESOURCE_NOT_FOUND" ||
      message.includes("not found")
    );
  });

const operationMessage = (operation: deploymentmanager.Operation) =>
  (operation.error?.errors ?? [])
    .map((error) => error.message ?? error.code ?? "")
    .filter((part) => part.length > 0)
    .join("; ") ||
  operation.httpErrorMessage ||
  `operation ${operation.status ?? "UNKNOWN"}`;

export const failIfErrored = (
  operation: deploymentmanager.Operation,
  options?: { notFoundOk?: boolean },
) => {
  const errors = operation.error?.errors ?? [];
  if (errors.length === 0 && (operation.httpErrorStatusCode ?? 0) < 400) {
    return Effect.succeed(operation);
  }
  if (alreadyExists(operation)) return Effect.succeed(operation);
  if (options?.notFoundOk === true && notFoundError(operation)) {
    return Effect.succeed(operation);
  }
  return Effect.fail(
    new DeploymentmanagerOperationFailed({
      operation: operation.name ?? "",
      message: operationMessage(operation),
    }),
  );
};

export const waitForOperation = (
  project: string,
  operation: deploymentmanager.Operation,
  options?: { notFoundOk?: boolean; times?: number },
) =>
  Effect.gen(function* () {
    const name = operation.name ? lastSegment(operation.name) : "";
    if (operation.status === "DONE") {
      return yield* failIfErrored(operation, options);
    }
    if (name.length === 0) {
      if (options?.notFoundOk === true) return operation;
      return yield* new DeploymentmanagerOperationFailed({
        operation: "",
        message: "operation is missing a name",
      });
    }

    const getOperation = deploymentmanager.getOperations({
      project,
      operation: name,
    });
    const resolved =
      options?.notFoundOk === true
        ? getOperation.pipe(
            Effect.catchTag("NotFound", () =>
              Effect.succeed<deploymentmanager.Operation>({
                name,
                status: "DONE",
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
        (current) => current.status === "DONE",
        (current) =>
          new DeploymentmanagerOperationPending({
            operation: name,
            status: current.status,
          }),
      ),
      Effect.flatMap((current) => failIfErrored(current, options)),
      Effect.retry({
        while: (error) =>
          error._tag === "GCP.Deploymentmanager.OperationPending",
        times: options?.times ?? 10,
        schedule: Schedule.spaced("3 seconds"),
      }),
    );
  });

export const waitUntilExists = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<NonNullable<A>, E | ResourceNotResolved, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value): value is NonNullable<A> => value != null,
      () => new ResourceNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Deploymentmanager.ResourceNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const waitUntilGone = <A, E extends { readonly _tag: string }, R>(
  get: Effect.Effect<A | undefined, E, R>,
  name: string,
): Effect.Effect<void, E | ResourceStillExists, R> =>
  get.pipe(
    Effect.filterOrFail(
      (value) => value === undefined,
      () => new ResourceStillExists({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Deploymentmanager.ResourceStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
    Effect.asVoid,
  );

export const isTransientForbidden = (error: {
  _tag: string;
  message?: string;
}) =>
  error._tag === "Forbidden" &&
  ((error.message ?? "").includes("has not been used") ||
    (error.message ?? "").includes("wait a few minutes") ||
    (error.message ?? "").includes("is not enabled"));

export const retryTransient = <
  A,
  E extends { _tag: string; message?: string },
  R,
>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (error) => isTransientForbidden(error),
      times: 8,
      schedule: Schedule.exponential("1 second"),
    }),
  );

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const getDeployment = (project: string, deployment: string) =>
  deploymentmanager
    .getDeployments({ project, deployment })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listOwnedDeployments = (project: string) =>
  collectPages(
    deploymentmanager.listDeployments.pages({
      project,
      maxResults: 500,
    }),
    (page) => page.deployments,
  ).pipe(
    Effect.map((items) =>
      items.filter((item) =>
        Object.keys(labelsToRecord(item.labels)).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
    ),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as deploymentmanager.Deployment[]),
    ),
  );

export const getManifest = (
  project: string,
  deployment: string,
  manifest: string | undefined,
) => {
  if (manifest === undefined || manifest.length === 0) {
    return Effect.succeed(undefined);
  }
  return deploymentmanager
    .getManifests({
      project,
      deployment,
      manifest: lastSegment(manifest),
    })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
};

export const settleDeployment = (
  project: string,
  item: deploymentmanager.Deployment,
) =>
  Effect.gen(function* () {
    const operation = item.operation;
    if (operation !== undefined && operation.status !== "DONE") {
      yield* waitForOperation(project, operation, { notFoundOk: true });
    }
  });
