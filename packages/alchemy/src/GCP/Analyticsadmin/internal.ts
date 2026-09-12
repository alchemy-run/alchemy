import * as analytics from "@distilled.cloud/gcp/analyticsadmin_v1beta";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_TIME_ZONE = "America/Chicago";
export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_PROPERTY_TYPE = "PROPERTY_TYPE_ORDINARY";
export const DEFAULT_STREAM_TYPE = "WEB_DATA_STREAM";
export const DEFAULT_COUNTING_METHOD = "ONCE_PER_EVENT";
export const MAX_PROPERTY_DISPLAY_NAME_LENGTH = 100;
export const MAX_DATA_STREAM_DISPLAY_NAME_LENGTH = 255;
export const MAX_SECRET_DISPLAY_NAME_LENGTH = 255;
export const MAX_EVENT_NAME_LENGTH = 40;
export const EVENT_NAME_PREFIX = "alc_";

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const parentOf = (name: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  return parts.slice(0, -2).join("/");
};

export const normalizeResourceName = (value: string) =>
  value.replace(/\/+$/, "");

export const toAccountName = (value: string) => {
  const trimmed = normalizeResourceName(value);
  return trimmed.startsWith("accounts/") ? trimmed : `accounts/${trimmed}`;
};

export const toPropertyName = (value: string) => {
  const trimmed = normalizeResourceName(value);
  return trimmed.startsWith("properties/") ? trimmed : `properties/${trimmed}`;
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

export const replaceOnIdentity = (args: {
  previousId: string | undefined;
  nextId: string | undefined;
}) => {
  if (
    args.previousId !== undefined &&
    args.nextId !== undefined &&
    args.previousId !== args.nextId
  ) {
    return { action: "replace" as const, deleteFirst: false };
  }
  return undefined;
};

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
  maxLength: number,
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

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

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

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: 40,
      lowercase: true,
    });
  });

export const toEventName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, MAX_EVENT_NAME_LENGTH);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing;
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength: MAX_EVENT_NAME_LENGTH - EVENT_NAME_PREFIX.length,
      lowercase: true,
      delimiter: "_",
    });
    const body = generated.replace(/-/g, "_");
    const next = `${EVENT_NAME_PREFIX}${body}`.slice(0, MAX_EVENT_NAME_LENGTH);
    return /^[A-Za-z]/.test(next)
      ? next
      : `a${next}`.slice(0, MAX_EVENT_NAME_LENGTH);
  });

export const hasOwnedEventName = (eventName: string | undefined) =>
  (eventName ?? "").startsWith(EVENT_NAME_PREFIX);

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <A, Page, E, R>(
  pages: Stream.Stream<Page, E, R>,
  pick: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(pick(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

export const listAccounts = () =>
  collectPages(
    analytics.listAccounts.pages({ pageSize: 200 }),
    (page) => page.accounts,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      emptyList<analytics.GoogleAnalyticsAdminV1betaAccount>(),
    ),
    Effect.catchTag("Forbidden", () =>
      emptyList<analytics.GoogleAnalyticsAdminV1betaAccount>(),
    ),
  );

export const listPropertiesForAccount = (accountName: string) =>
  collectPages(
    analytics.listProperties.pages({
      filter: `ancestor:${accountName}`,
      pageSize: 200,
      showDeleted: false,
    }),
    (page) => page.properties,
  ).pipe(
    Effect.catchTag("NotFound", () =>
      emptyList<analytics.GoogleAnalyticsAdminV1betaProperty>(),
    ),
    Effect.catchTag("Forbidden", () =>
      emptyList<analytics.GoogleAnalyticsAdminV1betaProperty>(),
    ),
  );

export const listAllProperties = () =>
  Effect.gen(function* () {
    const accounts = yield* listAccounts();
    const pages = yield* Effect.forEach(
      accounts,
      (account) =>
        account.name
          ? listPropertiesForAccount(account.name)
          : emptyList<analytics.GoogleAnalyticsAdminV1betaProperty>(),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedProperties = () =>
  listAllProperties().pipe(
    Effect.map((properties) =>
      properties.filter(
        (property) =>
          !property.deleteTime && hasOwnershipMarker(property.displayName),
      ),
    ),
  );

export const getProperty = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : analytics.getProperties({ name }).pipe(
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.map((property) =>
          property === undefined || property.deleteTime ? undefined : property,
        ),
      );

export const findOwnedProperty = (id: string) =>
  Effect.gen(function* () {
    const properties = yield* listAllProperties();
    for (const property of properties) {
      if (property.deleteTime) continue;
      if (yield* ownedByAlchemy(id, property.displayName)) {
        return property;
      }
    }
    return undefined;
  });

export const findPropertyByDisplayName = (displayName: string) =>
  Effect.gen(function* () {
    const properties = yield* listAllProperties();
    return properties.find(
      (property) =>
        !property.deleteTime && property.displayName === displayName,
    );
  });

export const getConversionEvent = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : analytics
        .getPropertiesConversionEvents({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listConversionEvents = (parent: string) =>
  parent.length === 0
    ? emptyList<analytics.GoogleAnalyticsAdminV1betaConversionEvent>()
    : collectPages(
        analytics.listPropertiesConversionEvents.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.conversionEvents,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<analytics.GoogleAnalyticsAdminV1betaConversionEvent>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<analytics.GoogleAnalyticsAdminV1betaConversionEvent>(),
        ),
      );

export const findConversionEventByEventName = (
  parent: string,
  eventName: string,
) =>
  listConversionEvents(parent).pipe(
    Effect.map((events) =>
      events.find((event) => event.eventName === eventName),
    ),
  );

export const getKeyEvent = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : analytics
        .getPropertiesKeyEvents({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listKeyEvents = (parent: string) =>
  parent.length === 0
    ? emptyList<analytics.GoogleAnalyticsAdminV1betaKeyEvent>()
    : collectPages(
        analytics.listPropertiesKeyEvents.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.keyEvents,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<analytics.GoogleAnalyticsAdminV1betaKeyEvent>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<analytics.GoogleAnalyticsAdminV1betaKeyEvent>(),
        ),
      );

export const findKeyEventByEventName = (parent: string, eventName: string) =>
  listKeyEvents(parent).pipe(
    Effect.map((events) =>
      events.find((event) => event.eventName === eventName),
    ),
  );

export const getDataStream = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : analytics
        .getPropertiesDataStreams({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listDataStreams = (parent: string) =>
  parent.length === 0
    ? emptyList<analytics.GoogleAnalyticsAdminV1betaDataStream>()
    : collectPages(
        analytics.listPropertiesDataStreams.pages({
          parent,
          pageSize: 200,
        }),
        (page) => page.dataStreams,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<analytics.GoogleAnalyticsAdminV1betaDataStream>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<analytics.GoogleAnalyticsAdminV1betaDataStream>(),
        ),
      );

export const findDataStreamByDisplayName = (
  parent: string,
  displayName: string,
) =>
  listDataStreams(parent).pipe(
    Effect.map((streams) =>
      streams.find((stream) => stream.displayName === displayName),
    ),
  );

export const getMeasurementProtocolSecret = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : analytics
        .getPropertiesDataStreamsMeasurementProtocolSecrets({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const listMeasurementProtocolSecrets = (parent: string) =>
  parent.length === 0
    ? emptyList<analytics.GoogleAnalyticsAdminV1betaMeasurementProtocolSecret>()
    : collectPages(
        analytics.listPropertiesDataStreamsMeasurementProtocolSecrets.pages({
          parent,
          pageSize: 10,
        }),
        (page) => page.measurementProtocolSecrets,
      ).pipe(
        Effect.catchTag("NotFound", () =>
          emptyList<analytics.GoogleAnalyticsAdminV1betaMeasurementProtocolSecret>(),
        ),
        Effect.catchTag("Forbidden", () =>
          emptyList<analytics.GoogleAnalyticsAdminV1betaMeasurementProtocolSecret>(),
        ),
      );

export const findSecretByDisplayName = (parent: string, displayName: string) =>
  listMeasurementProtocolSecrets(parent).pipe(
    Effect.map((secrets) =>
      secrets.find((secret) => secret.displayName === displayName),
    ),
  );

type IgnoreMissingError =
  | analytics.DeletePropertiesError
  | analytics.DeletePropertiesConversionEventsError
  | analytics.DeletePropertiesDataStreamsError
  | analytics.DeletePropertiesDataStreamsMeasurementProtocolSecretsError
  | analytics.DeletePropertiesKeyEventsError;

export const ignoreMissing = <A, R>(
  effect: Effect.Effect<A, IgnoreMissingError, R>,
) => effect.pipe(Effect.catchTag("NotFound", () => Effect.void));
