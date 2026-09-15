import * as fitness from "@distilled.cloud/gcp/fitness_v1";
import * as Effect from "effect/Effect";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_USER = "me";
export const DEFAULT_TYPE: fitness.DataSourceTypeEnum = "derived";
export const DEFAULT_DATA_TYPE_NAME = "com.google.step_count.delta";
export const DEFAULT_APPLICATION_NAME = "Alchemy";
export const MAX_NAME_LENGTH = 256;
export const ALL_DATA_DATASET_ID = "0-9223372036854775807";

export const DEFAULT_DATA_TYPE_FIELDS: fitness.DataTypeFieldList = [
  { name: "steps", format: "integer" },
];

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_NAME_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
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

export const hasOwnershipMarker = (text: string | undefined) => {
  if (
    Object.keys(parseOwnership(text).labels).some((key) =>
      key.startsWith("alchemy-"),
    )
  ) {
    return true;
  }
  return (text ?? "").toLowerCase().includes("alchemy-");
};

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const toUserId = (
  requested: string | undefined,
  existing: string | undefined,
) => requested ?? existing ?? DEFAULT_USER;

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested;
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `f${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

export const toDataStreamName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested;
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    return yield* createPhysicalName({
      id,
      maxLength: 64,
      lowercase: true,
    });
  });

export const defaultDataType = (): fitness.DataType => ({
  name: DEFAULT_DATA_TYPE_NAME,
  field: DEFAULT_DATA_TYPE_FIELDS,
});

export const applicationOf = (
  application: fitness.Application | undefined,
): fitness.Application | undefined => {
  if (application === undefined) return undefined;
  return {
    name: application.name,
    version: application.version,
    detailsUrl: application.detailsUrl,
  };
};

export const deviceOf = (
  device: fitness.Device | undefined,
): fitness.Device | undefined => {
  if (device === undefined) return undefined;
  return {
    version: device.version,
    model: device.model,
    manufacturer: device.manufacturer,
    uid: device.uid,
    type: device.type,
  };
};

export const deviceIdentityOf = (device: fitness.Device | undefined) => ({
  manufacturer: device?.manufacturer ?? "",
  model: device?.model ?? "",
  uid: device?.uid ?? "",
  type: device?.type ?? "",
});

export const dataTypeOf = (
  dataType: fitness.DataType | undefined,
): fitness.DataType | undefined => {
  if (dataType === undefined) return undefined;
  return {
    name: dataType.name,
    field: dataType.field,
  };
};

const emptyList = <A>() => Effect.succeed([] as A[]);

const catchGetMissing = <R>(
  effect: Effect.Effect<
    fitness.DataSource,
    fitness.GetUsersDataSourcesError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("Forbidden", () => Effect.succeed(undefined)),
    Effect.catchTag("Unauthorized", () => Effect.succeed(undefined)),
  );

const ignoreDeleteError = <A, R>(
  effect: Effect.Effect<
    A,
    | fitness.DeleteUsersDataSourcesError
    | fitness.DeleteUsersDataSourcesDatasetsError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.catchTag("Forbidden", () => Effect.void),
    Effect.catchTag("Unauthorized", () => Effect.void),
    Effect.catchTag("BadRequest", () => Effect.void),
    Effect.catchTag("Conflict", () => Effect.void),
  );

export const getDataSource = (userId: string, dataSourceId: string) =>
  dataSourceId.length === 0
    ? Effect.succeed(undefined)
    : catchGetMissing(
        fitness.getUsersDataSources({
          userId,
          dataSourceId,
        }),
      );

export const listDataSources = (userId: string) =>
  fitness.listUsersDataSources({ userId }).pipe(
    Effect.map((page) => page.dataSource ?? []),
    Effect.catchTag("NotFound", () => emptyList<fitness.DataSource>()),
    Effect.catchTag("Forbidden", () => emptyList<fitness.DataSource>()),
    Effect.catchTag("Unauthorized", () => emptyList<fitness.DataSource>()),
  );

export const listOwnedDataSources = (userId: string) =>
  listDataSources(userId).pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(item.name)),
    ),
  );

export const findOwnedDataSource = (
  userId: string,
  id: string,
  dataStreamName?: string,
) =>
  Effect.gen(function* () {
    const items = yield* listDataSources(userId);
    if (dataStreamName !== undefined && dataStreamName.length > 0) {
      const byStream = items.find(
        (item) => item.dataStreamName === dataStreamName,
      );
      if (byStream !== undefined) return byStream;
    }
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.name)) {
        return item;
      }
    }
    return undefined;
  });

export const clearDataSourceData = (userId: string, dataSourceId: string) =>
  dataSourceId.length === 0
    ? Effect.void
    : ignoreDeleteError(
        fitness.deleteUsersDataSourcesDatasets({
          userId,
          dataSourceId,
          datasetId: ALL_DATA_DATASET_ID,
        }),
      );

export const deleteDataSource = (userId: string, dataSourceId: string) =>
  Effect.gen(function* () {
    if (dataSourceId.length === 0) return;
    yield* clearDataSourceData(userId, dataSourceId);
    yield* ignoreDeleteError(
      fitness.deleteUsersDataSources({
        userId,
        dataSourceId,
      }),
    );
  });
