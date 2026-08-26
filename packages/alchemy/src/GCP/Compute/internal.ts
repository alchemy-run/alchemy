import * as compute from "@distilled.cloud/gcp/compute_v1";
import {
  waitGlobalOperations,
  waitGlobalOrganizationOperations,
  waitRegionOperations,
} from "./operations.ts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import { alchemyLabelKeys } from "../Labels.ts";

export const DEFAULT_REGION = "us-central1";
export const MAX_NAME_LENGTH = 63;

export const lastSegment = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? value;
};

export const normalizeRegion = (region: string | undefined) =>
  lastSegment(region ?? DEFAULT_REGION).toLowerCase();

export const rfc1035 = (name: string, fallback: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `${fallback[0] ?? "r"}${next}`;
  }
  next = next.slice(0, MAX_NAME_LENGTH).replace(/-+$/, "");
  return next.length > 0 ? next : fallback;
};

export const toPhysicalName = (
  id: string,
  name: string | undefined,
  existing: string | undefined,
  fallback: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: MAX_NAME_LENGTH,
        lowercase: true,
      }),
      fallback,
    );
  });

export const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
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

export const sameJson = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sorted = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export const sameUrlList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  sameJson(
    sorted((left ?? []).map(lastSegment)),
    sorted((right ?? []).map(lastSegment)),
  );

export const operationMessage = (operation: compute.Operation) =>
  (operation.error?.errors ?? [])
    .map((error) => error.message ?? error.code ?? "")
    .filter((part) => part.length > 0)
    .join("; ") ||
  operation.httpErrorMessage ||
  operation.statusMessage ||
  "Compute operation failed";

export const operationCodes = (operation: compute.Operation) =>
  (operation.error?.errors ?? []).map((item) =>
    (item.code ?? "").toUpperCase(),
  );

export const isAlreadyExists = (operation: compute.Operation) => {
  const codes = operationCodes(operation);
  const text = operationMessage(operation).toLowerCase();
  return (
    codes.includes("ALREADY_EXISTS") ||
    codes.includes("RESOURCE_ALREADY_EXISTS") ||
    codes.includes("ALREADYEXISTS") ||
    operation.httpErrorStatusCode === 409 ||
    text.includes("already exists")
  );
};

export const isNotFoundOperation = (operation: compute.Operation) => {
  const codes = operationCodes(operation);
  const text = operationMessage(operation).toLowerCase();
  return (
    operation.httpErrorStatusCode === 404 ||
    codes.includes("RESOURCE_NOT_FOUND") ||
    codes.includes("NOT_FOUND") ||
    codes.includes("NOTFOUND") ||
    text.includes("not found")
  );
};

export const failIfErrored = <E>(
  operation: compute.Operation,
  fail: (message: string) => E,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) => {
  if (options?.ignoreAlreadyExists === true && isAlreadyExists(operation)) {
    return Effect.succeed(operation);
  }
  if (options?.ignoreNotFound === true && isNotFoundOperation(operation)) {
    return Effect.succeed(operation);
  }
  const errors = operation.error?.errors ?? [];
  const httpFailed =
    operation.httpErrorStatusCode !== undefined &&
    operation.httpErrorStatusCode >= 400;
  if (errors.length === 0 && !httpFailed) {
    return Effect.succeed(operation);
  }
  return Effect.fail(fail(operationMessage(operation)));
};

export const waitRegion = (
  project: string,
  region: string,
  operation: compute.Operation,
  options?: { times?: number },
) =>
  Effect.gen(function* () {
    if (operation.status === "DONE") return operation;
    const name = lastSegment(operation.name ?? operation.id);
    if (name.length === 0) return operation;
    return yield* waitRegionOperations(
      { project, region, operation: name },
      { times: options?.times ?? 12 },
    );
  });

export const waitGlobal = (
  project: string,
  operation: compute.Operation,
  options?: { times?: number },
) =>
  Effect.gen(function* () {
    if (operation.status === "DONE") return operation;
    const name = lastSegment(operation.name ?? operation.id);
    if (name.length === 0) return operation;
    return yield* waitGlobalOperations(
      { project, operation: name },
      { times: options?.times ?? 12 },
    );
  });

export const waitOrg = (
  operation: compute.Operation,
  parentId: string | undefined,
  options?: { times?: number },
) =>
  Effect.gen(function* () {
    if (operation.status === "DONE") return operation;
    const name = lastSegment(operation.name ?? operation.id);
    if (name.length === 0) return operation;
    return yield* waitGlobalOrganizationOperations(
      { operation: name, parentId },
      { times: options?.times ?? 12 },
    ).pipe(
      Effect.retry({
        while: (error) => error._tag === "NotFound",
        times: 5,
        schedule: Schedule.exponential("250 millis"),
      }),
    );
  });

export const runRegionOp = <
  E extends { readonly _tag: string },
  R,
  F extends { readonly _tag: string },
>(
  project: string,
  region: string,
  start: Effect.Effect<compute.Operation, E, R>,
  fail: (operation: string, message: string) => F,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitRegion(project, region, operation).pipe(
        Effect.flatMap((done) =>
          failIfErrored(
            done,
            (message) => fail(done.name ?? operation.name ?? "", message),
            options,
          ),
        ),
      ),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const runGlobalOp = <
  E extends { readonly _tag: string },
  R,
  F extends { readonly _tag: string },
>(
  project: string,
  start: Effect.Effect<compute.Operation, E, R>,
  fail: (operation: string, message: string) => F,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitGlobal(project, operation).pipe(
        Effect.flatMap((done) =>
          failIfErrored(
            done,
            (message) => fail(done.name ?? operation.name ?? "", message),
            options,
          ),
        ),
      ),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const runOrgOp = <
  E extends { readonly _tag: string },
  R,
  F extends { readonly _tag: string },
>(
  parentId: string,
  start: Effect.Effect<compute.Operation, E, R>,
  fail: (operation: string, message: string) => F,
  options?: { ignoreAlreadyExists?: boolean; ignoreNotFound?: boolean },
) =>
  start.pipe(
    Effect.flatMap((operation) =>
      waitOrg(operation, parentId).pipe(
        Effect.flatMap((done) =>
          failIfErrored(
            done,
            (message) => fail(done.name ?? operation.name ?? "", message),
            options,
          ),
        ),
      ),
    ),
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      times: 5,
      schedule: Schedule.spaced("1 second"),
    }),
  );
