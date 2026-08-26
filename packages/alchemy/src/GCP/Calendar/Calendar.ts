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
  type ConferenceProperties,
  conferencePropertiesOf,
  encodeOwnership,
  findOwnedCalendar,
  getCalendar,
  hasOwnershipMarker,
  ignoreMissing,
  isPrimaryId,
  jsonEqual,
  listOwnedCalendars,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  PRIMARY,
  sameText,
  toGeneratedName,
} from "./internal.ts";

export type CalendarProps = {
  /**
   * Calendar id. Server-assigned on create (typically an email-shaped
   * id). Use `"primary"` for the authenticated user's primary calendar.
   * Immutable — changing it replaces the calendar.
   */
  calendarId?: string;
  /**
   * Title of the calendar. If omitted, a unique name is generated from
   * the stack, stage, and logical id.
   */
  summary?: string;
  /**
   * Description. Calendars have no labels field, so Alchemy ownership
   * is stored in a `[alchemy …]` prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Geographic location as free-form text.
   */
  location?: string;
  /**
   * IANA time zone (for example `"America/Chicago"`).
   */
  timeZone?: string;
  /**
   * Conferencing properties, for example which conference solutions
   * are allowed.
   */
  conferenceProperties?: ConferenceProperties;
  /**
   * Whether this calendar automatically accepts invitations. Only valid
   * for resource calendars.
   */
  autoAcceptInvitations?: boolean;
};

export type Calendar = Resource<
  "GCP.Calendar.Calendar",
  CalendarProps,
  {
    /** Calendar id. */
    calendarId: string;
    /** Project id used when the calendar was reconciled. */
    project: string;
    /** Title. */
    summary: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Geographic location. */
    location: string | undefined;
    /** IANA time zone. */
    timeZone: string | undefined;
    /** Conferencing properties. */
    conferenceProperties: ConferenceProperties | undefined;
    /** Whether invitations are auto-accepted. */
    autoAcceptInvitations: boolean | undefined;
    /** Email of the data owner, when returned. */
    dataOwner: string | undefined;
    /** ETag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Calendar secondary calendar.
 *
 * Calendars have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. The calendar id is identity —
 * changing it replaces the calendar. Summary, description, location,
 * time zone, and conference properties update in place. Primary
 * calendars cannot be deleted. Creating calendars as a service account
 * is not recommended; use a user OAuth token or domain-wide
 * delegation.
 *
 * ### Creating a Calendar
 * **Example:** Generated summary
 * ```typescript
 * const cal = yield* GCP.Calendar.Calendar("Team", {});
 * ```
 *
 * **Example:** Named calendar with a time zone
 * ```typescript
 * const cal = yield* GCP.Calendar.Calendar("Team", {
 *   summary: "Engineering",
 *   timeZone: "America/Chicago",
 *   location: "Chicago",
 * });
 * ```
 *
 * ### Updating a Calendar
 * **Example:** Rename
 * ```typescript
 * const cal = yield* GCP.Calendar.Calendar("Team", {
 *   calendarId: existing.calendarId,
 *   summary: "Platform",
 *   timeZone: "America/Chicago",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Calendar
 */
export const Calendar = Resource<Calendar>("GCP.Calendar.Calendar");

export class CalendarNotResolved extends Data.TaggedError(
  "GCP.Calendar.CalendarNotResolved",
)<{
  calendarId: string;
}> {}

const toAttrs = (item: calendar.Calendar, project: string) => ({
  calendarId: item.id ?? "",
  project,
  summary: item.summary,
  description: parseOwnership(item.description).text,
  location: item.location,
  timeZone: item.timeZone,
  conferenceProperties: conferencePropertiesOf(item.conferenceProperties),
  autoAcceptInvitations: item.autoAcceptInvitations,
  dataOwner: item.dataOwner,
  etag: item.etag,
});

const refresh = (calendarId: string, fallback: calendar.Calendar) =>
  getCalendar(calendarId).pipe(Effect.map((fresh) => fresh ?? fallback));

export const CalendarProvider = () =>
  Provider.succeed(Calendar, {
    stables: ["calendarId", "project", "dataOwner"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.calendarId ?? output?.calendarId;
      if (
        previousId !== undefined &&
        news.calendarId !== undefined &&
        news.calendarId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const calendarId = olds?.calendarId ?? output?.calendarId ?? "";
      let existing = yield* getCalendar(calendarId);
      if (existing === undefined) {
        existing = yield* findOwnedCalendar(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedCalendars();
        return items
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labels = yield* ownershipLabels(id);
      const summary = yield* toGeneratedName(id, news.summary, output?.summary);
      const description = encodeOwnership(labels, news.description);
      const desired: calendar.Calendar = {
        summary,
        description,
        location: news.location,
        timeZone: news.timeZone,
        conferenceProperties: news.conferenceProperties,
        autoAcceptInvitations: news.autoAcceptInvitations,
      };

      let current = yield* getCalendar(
        news.calendarId ?? output?.calendarId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedCalendar(id);
      }

      if (current === undefined) {
        const created = yield* calendar
          .insertCalendars({ body: desired })
          .pipe(Effect.catchTag("Conflict", () => findOwnedCalendar(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CalendarNotResolved({
          calendarId: news.calendarId ?? output?.calendarId ?? summary,
        });
      }

      const calendarId =
        current.id ?? news.calendarId ?? output?.calendarId ?? "";
      const summaryChanged = !sameText(current.summary, summary);
      const descriptionChanged = !sameText(current.description, description);
      const locationChanged =
        news.location !== undefined &&
        !sameText(current.location, news.location);
      const timeZoneChanged =
        news.timeZone !== undefined &&
        !sameText(current.timeZone, news.timeZone);
      const conferenceChanged =
        news.conferenceProperties !== undefined &&
        !jsonEqual(
          conferencePropertiesOf(current.conferenceProperties),
          news.conferenceProperties,
        );
      const autoAcceptChanged =
        news.autoAcceptInvitations !== undefined &&
        current.autoAcceptInvitations !== news.autoAcceptInvitations;

      if (
        summaryChanged ||
        descriptionChanged ||
        locationChanged ||
        timeZoneChanged ||
        conferenceChanged ||
        autoAcceptChanged
      ) {
        current = yield* calendar.patchCalendars({
          calendarId,
          body: desired,
        });
      }

      const fresh = yield* refresh(calendarId, current);
      return toAttrs(fresh, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (isPrimaryId(output.calendarId)) return;
      if (output.calendarId === PRIMARY) return;
      yield* ignoreMissing(
        calendar.deleteCalendars({
          calendarId: output.calendarId,
        }),
      );
    }),
  });
