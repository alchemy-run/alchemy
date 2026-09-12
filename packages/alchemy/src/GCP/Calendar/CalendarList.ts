import * as calendar from "@distilled.cloud/gcp/calendar_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type CalendarNotification,
  type ConferenceProperties,
  type EventReminder,
  conferencePropertiesOf,
  encodeOwnershipLine,
  findOwnedCalendarList,
  getCalendarListEntry,
  hasOwnershipMarker,
  ignoreMissing,
  isPrimaryId,
  jsonEqual,
  listOwnedCalendarList,
  MAX_SUMMARY_OVERRIDE_LENGTH,
  notificationsOf,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameBoolean,
  sameText,
} from "./internal.ts";

export type CalendarListProps = {
  /**
   * Calendar id to insert into the authenticated user's calendar list.
   * Immutable — changing it replaces the list entry.
   */
  calendarId: string;
  /**
   * User-set title override. Calendar list entries have no labels
   * field, so Alchemy ownership is stored in a `[alchemy …]` prefix
   * and stripped from attributes.
   */
  summaryOverride?: string;
  /**
   * Color id from the calendar colors endpoint.
   */
  colorId?: string;
  /**
   * Background color as `#0088aa`. Requires RGB format on write.
   */
  backgroundColor?: string;
  /**
   * Foreground color as `#ffffff`. Requires RGB format on write.
   */
  foregroundColor?: string;
  /**
   * Hide the calendar from the list.
   */
  hidden?: boolean;
  /**
   * Whether the calendar content shows in the calendar UI.
   */
  selected?: boolean;
  /**
   * Default reminders for this calendar in the user's list.
   */
  defaultReminders?: EventReminder[];
  /**
   * Notification settings for this calendar in the user's list.
   */
  notificationSettings?: { notifications?: CalendarNotification[] };
};

export type CalendarList = Resource<
  "GCP.Calendar.CalendarList",
  CalendarListProps,
  {
    /** Calendar id. */
    calendarId: string;
    /** Project id used when the list entry was reconciled. */
    project: string;
    /** Effective access role. */
    accessRole: string | undefined;
    /** Calendar title. */
    summary: string | undefined;
    /** User-facing override with the Alchemy ownership prefix stripped. */
    summaryOverride: string | undefined;
    /** Description from the underlying calendar. */
    description: string | undefined;
    /** Geographic location. */
    location: string | undefined;
    /** IANA time zone. */
    timeZone: string | undefined;
    /** Color id. */
    colorId: string | undefined;
    /** Background color. */
    backgroundColor: string | undefined;
    /** Foreground color. */
    foregroundColor: string | undefined;
    /** Whether the entry is hidden. */
    hidden: boolean;
    /** Whether the calendar is selected in the UI. */
    selected: boolean;
    /** Whether this is the primary calendar. */
    primary: boolean;
    /** Whether the list entry is deleted. */
    deleted: boolean;
    /** Default reminders. */
    defaultReminders: EventReminder[] | undefined;
    /** Notification settings. */
    notificationSettings:
      | { notifications?: CalendarNotification[] }
      | undefined;
    /** Conferencing properties. */
    conferenceProperties: ConferenceProperties | undefined;
    /** Email of the data owner, when returned. */
    dataOwner: string | undefined;
    /** ETag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * An entry on the authenticated user's Google Calendar list.
 *
 * Inserts an existing calendar into the list (secondary calendars are
 * added automatically on create). Alchemy stamps ownership into
 * `summaryOverride` for `list` / nuke. The calendar id is identity —
 * changing it replaces the entry. Colors, hidden, selected, reminders,
 * and notifications update in place. The primary calendar cannot be
 * removed from the list.
 *
 * ### Creating a List Entry
 * **Example:** Subscribe to a public calendar
 * ```typescript
 * const entry = yield* GCP.Calendar.CalendarList("Holidays", {
 *   calendarId: "en.usa#holiday@group.v.calendar.google.com",
 *   summaryOverride: "US Holidays",
 *   selected: true,
 * });
 * ```
 *
 * ### Updating a List Entry
 * **Example:** Hide the calendar
 * ```typescript
 * const entry = yield* GCP.Calendar.CalendarList("Holidays", {
 *   calendarId: existing.calendarId,
 *   summaryOverride: "US Holidays",
 *   hidden: true,
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Calendar
 */
export const CalendarList = Resource<CalendarList>("GCP.Calendar.CalendarList");

export class CalendarListNotResolved extends Data.TaggedError(
  "GCP.Calendar.CalendarListNotResolved",
)<{
  calendarId: string;
}> {}

const toAttrs = (item: calendar.CalendarListEntry, project: string) => ({
  calendarId: item.id ?? "",
  project,
  accessRole: item.accessRole,
  summary: item.summary,
  summaryOverride: parseOwnership(item.summaryOverride).text,
  description: item.description,
  location: item.location,
  timeZone: item.timeZone,
  colorId: item.colorId,
  backgroundColor: item.backgroundColor,
  foregroundColor: item.foregroundColor,
  hidden: item.hidden === true,
  selected: item.selected === true,
  primary: item.primary === true,
  deleted: item.deleted === true,
  defaultReminders: item.defaultReminders,
  notificationSettings:
    item.notificationSettings === undefined
      ? undefined
      : { notifications: notificationsOf(item.notificationSettings) },
  conferenceProperties: conferencePropertiesOf(item.conferenceProperties),
  dataOwner: item.dataOwner,
  etag: item.etag,
});

const usesRgb = (news: CalendarListProps) =>
  news.backgroundColor !== undefined || news.foregroundColor !== undefined;

export const CalendarListProvider = () =>
  Provider.succeed(CalendarList, {
    stables: ["calendarId", "project", "accessRole", "primary", "dataOwner"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.calendarId ?? output?.calendarId;
      if (previousId !== undefined && news.calendarId !== previousId) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const calendarId = olds?.calendarId ?? output?.calendarId ?? "";
      const existing = yield* findOwnedCalendarList(id, calendarId);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.summaryOverride))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedCalendarList();
        return items
          .filter((item) => hasOwnershipMarker(item.summaryOverride))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const calendarId = news.calendarId;
      const labels = yield* ownershipLabels(id);
      const summaryOverride = encodeOwnershipLine(
        labels,
        news.summaryOverride,
        MAX_SUMMARY_OVERRIDE_LENGTH,
      );
      const colorRgbFormat = usesRgb(news);
      const desired: calendar.CalendarListEntry = {
        id: calendarId,
        summaryOverride,
        colorId: news.colorId,
        backgroundColor: news.backgroundColor,
        foregroundColor: news.foregroundColor,
        hidden: news.hidden,
        selected: news.selected,
        defaultReminders: news.defaultReminders,
        notificationSettings: news.notificationSettings,
      };

      let current = yield* findOwnedCalendarList(
        id,
        news.calendarId ?? output?.calendarId ?? "",
      );

      if (current === undefined) {
        const created = yield* calendar
          .insertCalendarList({
            colorRgbFormat,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () => getCalendarListEntry(calendarId)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CalendarListNotResolved({ calendarId });
      }

      const entryId = current.id ?? calendarId;
      const overrideChanged = !sameText(
        current.summaryOverride,
        summaryOverride,
      );
      const colorChanged =
        news.colorId !== undefined && !sameText(current.colorId, news.colorId);
      const backgroundChanged =
        news.backgroundColor !== undefined &&
        !sameText(current.backgroundColor, news.backgroundColor);
      const foregroundChanged =
        news.foregroundColor !== undefined &&
        !sameText(current.foregroundColor, news.foregroundColor);
      const hiddenChanged =
        news.hidden !== undefined && !sameBoolean(current.hidden, news.hidden);
      const selectedChanged =
        news.selected !== undefined &&
        !sameBoolean(current.selected, news.selected);
      const remindersChanged =
        news.defaultReminders !== undefined &&
        !jsonEqual(current.defaultReminders, news.defaultReminders);
      const notificationsChanged =
        news.notificationSettings !== undefined &&
        !jsonEqual(
          notificationsOf(current.notificationSettings),
          news.notificationSettings.notifications,
        );

      if (
        overrideChanged ||
        colorChanged ||
        backgroundChanged ||
        foregroundChanged ||
        hiddenChanged ||
        selectedChanged ||
        remindersChanged ||
        notificationsChanged
      ) {
        current = yield* calendar.patchCalendarList({
          calendarId: entryId,
          colorRgbFormat,
          body: desired,
        });
      }

      const fresh = yield* getCalendarListEntry(entryId);
      return toAttrs(fresh ?? current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (isPrimaryId(output.calendarId, output.primary)) return;
      yield* ignoreMissing(
        calendar.deleteCalendarList({
          calendarId: output.calendarId,
        }),
      );
    }),
  });
