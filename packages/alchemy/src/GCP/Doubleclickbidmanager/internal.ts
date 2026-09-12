import * as bidmanager from "@distilled.cloud/gcp/doubleclickbidmanager_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const MAX_TITLE_LENGTH = 240;

export const DEFAULT_TYPE: bidmanager.ParametersTypeEnum = "STANDARD";
export const DEFAULT_FORMAT: bidmanager.QueryMetadataFormatEnum = "CSV";
export const DEFAULT_RANGE: bidmanager.DataRangeRangeEnum = "LAST_7_DAYS";
export const DEFAULT_FREQUENCY: bidmanager.QueryScheduleFrequencyEnum =
  "ONE_TIME";
export const DEFAULT_GROUP_BYS = ["FILTER_DATE"] as const;
export const DEFAULT_METRICS = ["METRIC_IMPRESSIONS"] as const;
export const DEFAULT_DATA_RANGE: bidmanager.DataRange = {
  range: DEFAULT_RANGE,
};
export const DEFAULT_SCHEDULE: bidmanager.QuerySchedule = {
  frequency: DEFAULT_FREQUENCY,
};

export const PROBE_QUERY_ID = "0";

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

const canonical = (value: unknown): unknown => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
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

export const jsonEqual = (left: unknown, right: unknown) =>
  fingerprint(left) === fingerprint(right);

export const replaceIfChanged = (
  previous: string | undefined,
  next: string | undefined,
  deleteFirst = false,
) => {
  if (previous !== undefined && next !== undefined && previous !== next) {
    return { action: "replace" as const, deleteFirst };
  }
  return undefined;
};

export const replaceIfFingerprintChanged = (
  previous: unknown | undefined,
  next: unknown,
) => {
  if (previous === undefined) return undefined;
  if (!jsonEqual(previous, next)) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

const markerOf = (stack: string, stage: string, id: string) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

export const fitMarker = (
  labels: Record<string, string>,
  maxLength: number,
) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (id.length >= stack.length && id.length >= stage.length) {
      id = id.slice(0, -1);
    } else if (stack.length >= stage.length) {
      stack = stack.slice(0, -1);
    } else {
      stage = stage.slice(0, -1);
    }
    marker = markerOf(stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeTitle = (
  labels: Record<string, string>,
  title: string | undefined,
  maxLength = MAX_TITLE_LENGTH,
): string => {
  const trimmed = title?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
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

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, title: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseTitle(title);
    if (!hasOwnershipMarker(title)) return false;
    if (yield* hasAlchemyLabels(id, labels)) return true;
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

export const toDisplayTitle = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `q${generated}`.slice(0, 40);
  });

export const ownedTitle = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    const labels = yield* ownershipLabels(id);
    const user = yield* toDisplayTitle(id, requested, existing);
    return encodeTitle(labels, user);
  });

const emptyQueries = () => Effect.succeed([] as bidmanager.Query[]);

export const getQuery = (queryId: string | undefined) =>
  !queryId
    ? Effect.succeed(undefined)
    : bidmanager
        .getQueries({ queryId })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listQueries = () =>
  bidmanager.listQueries.pages({ pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.queries ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", emptyQueries),
    Effect.catchTag("Forbidden", emptyQueries),
  );

export const listOwnedQueries = () =>
  listQueries().pipe(
    Effect.map((rows) =>
      rows.filter((row) => hasOwnershipMarker(row.metadata?.title)),
    ),
  );

export const findOwnedQuery = (id: string, title?: string) =>
  Effect.gen(function* () {
    const rows = yield* listQueries();
    if (title) {
      const exact = rows.find((row) => sameText(row.metadata?.title, title));
      if (exact) return exact;
    }
    for (const row of rows) {
      if (yield* ownedByAlchemy(id, row.metadata?.title)) {
        return row;
      }
    }
    return undefined;
  });

export const sortedStrings = (values: readonly string[] | undefined) =>
  [...(values ?? [])].slice().sort();

export type QueryDefinition = {
  title: string | undefined;
  dataRange: bidmanager.DataRange | undefined;
  format: string | undefined;
  sendNotification: boolean;
  shareEmailAddress: string[];
  type: string | undefined;
  groupBys: string[] | undefined;
  filters: bidmanager.FilterPair[] | undefined;
  metrics: string[] | undefined;
  options: bidmanager.Options | undefined;
  schedule: bidmanager.QuerySchedule | undefined;
};

export const definitionOf = (input: {
  title?: string;
  dataRange?: bidmanager.DataRange;
  format?: string;
  sendNotification?: boolean;
  shareEmailAddress?: string[];
  type?: string;
  groupBys?: string[];
  filters?: bidmanager.FilterPair[];
  metrics?: string[];
  options?: bidmanager.Options;
  schedule?: bidmanager.QuerySchedule;
}): QueryDefinition => ({
  title: input.title,
  dataRange: input.dataRange ?? DEFAULT_DATA_RANGE,
  format: input.format ?? DEFAULT_FORMAT,
  sendNotification: input.sendNotification === true,
  shareEmailAddress: sortedStrings(input.shareEmailAddress),
  type: input.type ?? DEFAULT_TYPE,
  groupBys: input.groupBys ?? [...DEFAULT_GROUP_BYS],
  filters: input.filters,
  metrics: input.metrics ?? [...DEFAULT_METRICS],
  options: input.options,
  schedule: input.schedule ?? DEFAULT_SCHEDULE,
});

export const definitionFromRow = (row: bidmanager.Query): QueryDefinition =>
  definitionOf({
    title: parseTitle(row.metadata?.title).title,
    dataRange: row.metadata?.dataRange,
    format: row.metadata?.format,
    sendNotification: row.metadata?.sendNotification,
    shareEmailAddress: row.metadata?.shareEmailAddress,
    type: row.params?.type,
    groupBys: row.params?.groupBys,
    filters: row.params?.filters,
    metrics: row.params?.metrics,
    options: row.params?.options,
    schedule: row.schedule,
  });

export const desiredBody = (
  title: string,
  definition: QueryDefinition,
): bidmanager.Query => ({
  metadata: {
    title,
    dataRange: definition.dataRange,
    format: definition.format,
    sendNotification: definition.sendNotification,
    shareEmailAddress:
      definition.shareEmailAddress.length > 0
        ? definition.shareEmailAddress
        : undefined,
  },
  params: {
    type: definition.type,
    groupBys: definition.groupBys,
    filters: definition.filters,
    metrics: definition.metrics,
    options: definition.options,
  },
  schedule: definition.schedule,
});
