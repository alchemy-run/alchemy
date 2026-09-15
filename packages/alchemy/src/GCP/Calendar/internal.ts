import * as calendar from "@distilled.cloud/gcp/calendar_v3";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import { tagRecord } from "../../Tags.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";

export const PRIMARY = "primary";
export const ALCHEMY_PROPERTY_MARKER = "alchemy";
export const MAX_SUMMARY_LENGTH = 1024;
export const MAX_SUMMARY_OVERRIDE_LENGTH = 1024;
export const OWNERSHIP_QUERY = "[alchemy";

export type EventDateTime = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

export type EventReminder = {
  method?: string;
  minutes?: number;
};

export type ConferenceProperties = {
  allowedConferenceSolutionTypes?: string[];
};

export type CalendarNotification = {
  method?: string;
  type?: string;
};

export type AclRuleScope = {
  type?: string;
  value?: string;
};

export type EventExtendedProperties = {
  private?: Record<string, string>;
  shared?: Record<string, string>;
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

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
): string => {
  const marker = fitMarker(labels, 8000);
  const trimmed = text?.trim();
  return trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_SUMMARY_LENGTH,
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

export const sameBoolean = (
  left: boolean | undefined,
  right: boolean | undefined,
) => (left ?? false) === (right ?? false);

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const isPrimaryId = (calendarId: string, primary?: boolean) =>
  primary === true || calendarId === PRIMARY || calendarId.length === 0;

export const toGeneratedName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = 40,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    const generated = yield* createPhysicalName({
      id,
      maxLength,
      lowercase: true,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `c${generated}`.slice(0, maxLength);
    return next.length >= 4 ? next : `${next}xxxx`.slice(0, maxLength);
  });

const emptyList = <A>() => Effect.succeed([] as A[]);

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.succeed(undefined),
    ),
  );

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) =>
  effect.pipe(
    Effect.catchIf(
      (error): error is E & { readonly _tag: "NotFound" | "Forbidden" } =>
        error._tag === "NotFound" || error._tag === "Forbidden",
      () => Effect.void,
    ),
  );

export const conferencePropertiesOf = (
  properties: calendar.ConferenceProperties | undefined,
): ConferenceProperties | undefined => {
  if (properties === undefined) return undefined;
  return {
    allowedConferenceSolutionTypes: properties.allowedConferenceSolutionTypes,
  };
};

export const dateTimeOf = (
  value: calendar.EventDateTime | undefined,
): EventDateTime | undefined => {
  if (value === undefined) return undefined;
  return {
    date: value.date,
    dateTime: value.dateTime,
    timeZone: value.timeZone,
  };
};

export const remindersOf = (
  reminders: calendar.EventReminders | undefined,
): calendar.EventReminders | undefined => {
  if (reminders === undefined) return undefined;
  return {
    useDefault: reminders.useDefault,
    overrides: reminders.overrides?.map((item) => ({
      method: item.method,
      minutes: item.minutes,
    })),
  };
};

export const notificationsOf = (
  settings: calendar.CalendarListEntryNotificationSettings | undefined,
): CalendarNotification[] | undefined => {
  const notifications = settings?.notifications;
  if (notifications === undefined) return undefined;
  return notifications.map((item) => ({
    method: item.method,
    type: item.type,
  }));
};

export const scopeOf = (
  scope: calendar.AclRuleScope | undefined,
): AclRuleScope | undefined => {
  if (scope === undefined) return undefined;
  return { type: scope.type, value: scope.value };
};

export const aclRuleIdOf = (scope: AclRuleScope | undefined) => {
  const type = scope?.type ?? "default";
  if (type === "default") return "default";
  return `${type}:${(scope?.value ?? "").toLowerCase()}`;
};

export const userPrivateProperties = (
  properties: Record<string, string | undefined> | null | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(stripInternalLabels(tagRecord(properties))).filter(
      ([key]) => key !== ALCHEMY_PROPERTY_MARKER,
    ),
  );

export const desiredEventPrivate = (
  id: string,
  user: Record<string, string> | undefined,
) =>
  Effect.gen(function* () {
    const internal = yield* createInternalLabels(id);
    return {
      ...toLabels(user),
      ...internal,
      [ALCHEMY_PROPERTY_MARKER]: "true",
    };
  });

export const hasAlchemyEventMarker = (event: calendar.Event) => {
  const properties = tagRecord(event.extendedProperties?.private);
  return (
    properties[ALCHEMY_PROPERTY_MARKER] === "true" ||
    Object.keys(properties).some((key) => key.startsWith("alchemy-")) ||
    hasOwnershipMarker(event.description)
  );
};

export const eventOwnedByAlchemy = (id: string, event: calendar.Event) =>
  Effect.gen(function* () {
    if (
      yield* hasAlchemyLabels(id, tagRecord(event.extendedProperties?.private))
    ) {
      return true;
    }
    return yield* ownedByAlchemy(id, event.description);
  });

export const extendedPropertiesOf = (
  properties: calendar.EventExtendedProperties | undefined,
): EventExtendedProperties | undefined => {
  if (properties === undefined) return undefined;
  const privateProps = userPrivateProperties(properties.private);
  const shared = tagRecord(properties.shared);
  if (
    Object.keys(privateProps).length === 0 &&
    Object.keys(shared).length === 0
  ) {
    return undefined;
  }
  return {
    private: Object.keys(privateProps).length > 0 ? privateProps : undefined,
    shared: Object.keys(shared).length > 0 ? shared : undefined,
  };
};

export const getCalendar = (calendarId: string) =>
  calendarId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(calendar.getCalendars({ calendarId }));

export const listCalendarList = () =>
  calendar.listCalendarList
    .pages({
      maxResults: 100,
      showHidden: true,
      showDeleted: false,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () =>
        emptyList<calendar.CalendarListEntry>(),
      ),
      Effect.catchTag("Forbidden", () =>
        emptyList<calendar.CalendarListEntry>(),
      ),
    );

export const calendarFromListEntry = (
  entry: calendar.CalendarListEntry,
): calendar.Calendar => ({
  id: entry.id,
  summary: entry.summary,
  description: entry.description,
  timeZone: entry.timeZone,
  location: entry.location,
  conferenceProperties: entry.conferenceProperties,
  dataOwner: entry.dataOwner,
});

export const listOwnedCalendars = () =>
  Effect.gen(function* () {
    const entries = yield* listCalendarList();
    const owned = entries.filter(
      (entry) =>
        hasOwnershipMarker(entry.description) ||
        hasOwnershipMarker(entry.summary),
    );
    const calendars = yield* Effect.forEach(
      owned.filter((entry) => (entry.id ?? "").length > 0),
      (entry) =>
        getCalendar(entry.id ?? "").pipe(
          Effect.map((item) => item ?? calendarFromListEntry(entry)),
        ),
      { concurrency: 4 },
    );
    return calendars.filter(
      (item): item is calendar.Calendar =>
        item !== undefined && hasOwnershipMarker(item.description),
    );
  });

export const findOwnedCalendar = (id: string) =>
  Effect.gen(function* () {
    const calendars = yield* listOwnedCalendars();
    for (const item of calendars) {
      if (yield* ownedByAlchemy(id, item.description)) {
        return item;
      }
    }
    return undefined;
  });

export const getCalendarListEntry = (calendarId: string) =>
  calendarId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(calendar.getCalendarList({ calendarId }));

export const listOwnedCalendarList = () =>
  listCalendarList().pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(item.summaryOverride)),
    ),
  );

export const findOwnedCalendarList = (id: string, calendarId: string) =>
  Effect.gen(function* () {
    if (calendarId.length > 0) {
      const existing = yield* getCalendarListEntry(calendarId);
      if (existing !== undefined) return existing;
    }
    const items = yield* listOwnedCalendarList();
    for (const item of items) {
      if (yield* ownedByAlchemy(id, item.summaryOverride)) {
        return item;
      }
    }
    return undefined;
  });

export const getAcl = (calendarId: string, ruleId: string) =>
  calendarId.length === 0 || ruleId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(calendar.getAcl({ calendarId, ruleId }));

export const listAcl = (calendarId: string) =>
  calendarId.length === 0
    ? emptyList<calendar.AclRule>()
    : calendar.listAcl
        .pages({
          calendarId,
          maxResults: 100,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<calendar.AclRule>()),
          Effect.catchTag("Forbidden", () => emptyList<calendar.AclRule>()),
        );

export const isManagedAcl = (rule: calendar.AclRule) =>
  rule.role !== "owner" && rule.role !== "none";

export const aclMatches = (
  rule: calendar.AclRule,
  news: {
    ruleId?: string;
    scope?: AclRuleScope;
  },
) => {
  if (
    news.ruleId !== undefined &&
    news.ruleId.length > 0 &&
    rule.id === news.ruleId
  ) {
    return true;
  }
  const expectedId = aclRuleIdOf(news.scope);
  if (rule.id === expectedId) return true;
  const type = news.scope?.type;
  const value = (news.scope?.value ?? "").toLowerCase();
  if (type !== undefined && (rule.scope?.type ?? "") !== type) {
    return false;
  }
  if (value.length > 0 && (rule.scope?.value ?? "").toLowerCase() !== value) {
    return false;
  }
  return type !== undefined;
};

export const findAcl = (
  calendarId: string,
  news: {
    ruleId?: string;
    scope?: AclRuleScope;
  },
) =>
  Effect.gen(function* () {
    const ruleId =
      news.ruleId !== undefined && news.ruleId.length > 0
        ? news.ruleId
        : aclRuleIdOf(news.scope);
    const existing = yield* getAcl(calendarId, ruleId);
    if (existing !== undefined) return existing;
    const rules = yield* listAcl(calendarId);
    return rules.find((rule) => aclMatches(rule, news));
  });

export type AclWithCalendar = calendar.AclRule & { calendarId: string };

export const listManagedAcls = () =>
  Effect.gen(function* () {
    const calendars = yield* listOwnedCalendars();
    const pages = yield* Effect.forEach(
      calendars.filter((item) => (item.id ?? "").length > 0),
      (item) =>
        listAcl(item.id ?? "").pipe(
          Effect.map((rules) =>
            rules.filter(isManagedAcl).map((rule): AclWithCalendar => ({
              ...rule,
              calendarId: item.id ?? "",
            })),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const getEvent = (calendarId: string, eventId: string) =>
  calendarId.length === 0 || eventId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(calendar.getEvents({ calendarId, eventId }));

export const listEvents = (calendarId: string) =>
  calendarId.length === 0
    ? emptyList<calendar.Event>()
    : calendar.listEvents
        .pages({
          calendarId,
          maxResults: 100,
          q: OWNERSHIP_QUERY,
          showDeleted: false,
        })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag("NotFound", () => emptyList<calendar.Event>()),
          Effect.catchTag("Forbidden", () => emptyList<calendar.Event>()),
        );

export type EventWithCalendar = calendar.Event & { calendarId: string };

export const listOwnedEventsOnCalendar = (calendarId: string) =>
  listEvents(calendarId).pipe(
    Effect.map((events) =>
      events.filter(hasAlchemyEventMarker).map((event): EventWithCalendar => ({
        ...event,
        calendarId,
      })),
    ),
  );

export const eventCalendarIds = () =>
  Effect.gen(function* () {
    const entries = yield* listCalendarList();
    const ids = new Set<string>([PRIMARY]);
    for (const entry of entries) {
      if (
        (entry.id ?? "").length > 0 &&
        (hasOwnershipMarker(entry.description) ||
          hasOwnershipMarker(entry.summary) ||
          hasOwnershipMarker(entry.summaryOverride) ||
          entry.primary === true)
      ) {
        ids.add(entry.id ?? "");
      }
    }
    return Array.from(ids);
  });

export const listOwnedEvents = () =>
  Effect.gen(function* () {
    const calendarIds = yield* eventCalendarIds();
    const pages = yield* Effect.forEach(
      calendarIds,
      (calendarId) => listOwnedEventsOnCalendar(calendarId),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const findOwnedEvent = (id: string, calendarId: string) =>
  Effect.gen(function* () {
    const events =
      calendarId.length > 0
        ? yield* listOwnedEventsOnCalendar(calendarId)
        : yield* listOwnedEvents();
    for (const event of events) {
      if (yield* eventOwnedByAlchemy(id, event)) {
        return event;
      }
    }
    return undefined;
  });
