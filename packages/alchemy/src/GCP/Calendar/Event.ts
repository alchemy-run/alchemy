import * as calendar from "@distilled.cloud/gcp/calendar_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  type EventDateTime,
  type EventExtendedProperties,
  dateTimeOf,
  desiredEventPrivate,
  encodeOwnership,
  eventOwnedByAlchemy,
  extendedPropertiesOf,
  findOwnedEvent,
  getEvent,
  hasAlchemyEventMarker,
  ignoreMissing,
  jsonEqual,
  listOwnedEvents,
  parseOwnership,
  remindersOf,
  sameBoolean,
  sameText,
  toGeneratedName,
} from "./internal.ts";

export type EventProps = {
  /**
   * Parent calendar id (`"primary"` or a secondary calendar id).
   * Immutable — changing it replaces the event.
   */
  calendarId: string;
  /**
   * Event id. Server-assigned on create unless provided. Immutable —
   * changing it replaces the event.
   */
  eventId?: string;
  /**
   * Title of the event. If omitted, a unique name is generated from
   * the stack, stage, and logical id.
   */
  summary?: string;
  /**
   * Description. Events have no labels field, so Alchemy ownership is
   * stored in a `[alchemy …]` prefix and in private extended
   * properties, then stripped from attributes.
   */
  description?: string;
  /**
   * Geographic location as free-form text.
   */
  location?: string;
  /**
   * Inclusive start time.
   */
  start: EventDateTime;
  /**
   * Exclusive end time.
   */
  end: EventDateTime;
  /**
   * Whether the end time is unspecified.
   */
  endTimeUnspecified?: boolean;
  /**
   * RRULE, EXRULE, RDATE, and EXDATE lines as specified in RFC5545.
   */
  recurrence?: string[];
  /**
   * Event status: `confirmed`, `tentative`, or `cancelled`.
   */
  status?: string;
  /**
   * Visibility: `default`, `public`, `private`, or `confidential`.
   */
  visibility?: string;
  /**
   * Busy/free: `opaque` or `transparent`.
   */
  transparency?: string;
  /**
   * Event color id from the colors endpoint.
   */
  colorId?: string;
  /**
   * Reminders for the authenticated user.
   */
  reminders?: calendar.EventReminders;
  /**
   * Attendees. Service accounts need domain-wide delegation to
   * populate this list.
   */
  attendees?: calendar.EventAttendee[];
  /**
   * Whether guests can invite others.
   * @default true
   */
  guestsCanInviteOthers?: boolean;
  /**
   * Whether guests can modify the event.
   * @default false
   */
  guestsCanModify?: boolean;
  /**
   * Whether guests can see other guests.
   * @default true
   */
  guestsCanSeeOtherGuests?: boolean;
  /**
   * Whether anyone can add themselves (deprecated).
   */
  anyoneCanAddSelf?: boolean;
  /**
   * Event type. Immutable after create — changing it replaces the
   * event.
   */
  eventType?: string;
  /**
   * User extended properties. Alchemy ownership keys are merged into
   * `private`.
   */
  extendedProperties?: EventExtendedProperties;
  /**
   * Source from which the event was created.
   */
  source?: calendar.EventSource;
  /**
   * File attachments. Writes set `supportsAttachments`.
   */
  attachments?: calendar.EventAttachment[];
  /**
   * Conference data. Writes set `conferenceDataVersion` to 1.
   */
  conferenceData?: calendar.ConferenceData;
  /**
   * Working-location event data.
   */
  workingLocationProperties?: calendar.EventWorkingLocationProperties;
  /**
   * Focus-time event data.
   */
  focusTimeProperties?: calendar.EventFocusTimeProperties;
  /**
   * Out-of-office event data.
   */
  outOfOfficeProperties?: calendar.EventOutOfOfficeProperties;
  /**
   * Birthday event data.
   */
  birthdayProperties?: calendar.EventBirthdayProperties;
  /**
   * Who should receive notifications about inserts and updates.
   * @default "none"
   */
  sendUpdates?: calendar.InsertEventsSendUpdatesEnum | (string & {});
};

export type Event = Resource<
  "GCP.Calendar.Event",
  EventProps,
  {
    /** Event id. */
    eventId: string;
    /** Parent calendar id. */
    calendarId: string;
    /** Project id used when the event was reconciled. */
    project: string;
    /** Title. */
    summary: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Geographic location. */
    location: string | undefined;
    /** Inclusive start time. */
    start: EventDateTime | undefined;
    /** Exclusive end time. */
    end: EventDateTime | undefined;
    /** Whether the end time is unspecified. */
    endTimeUnspecified: boolean | undefined;
    /** Recurrence lines. */
    recurrence: string[] | undefined;
    /** Status. */
    status: string | undefined;
    /** Visibility. */
    visibility: string | undefined;
    /** Busy/free. */
    transparency: string | undefined;
    /** Color id. */
    colorId: string | undefined;
    /** Reminders. */
    reminders: calendar.EventReminders | undefined;
    /** Attendees. */
    attendees: calendar.EventAttendee[] | undefined;
    /** Whether guests can invite others. */
    guestsCanInviteOthers: boolean | undefined;
    /** Whether guests can modify the event. */
    guestsCanModify: boolean | undefined;
    /** Whether guests can see other guests. */
    guestsCanSeeOtherGuests: boolean | undefined;
    /** Event type. */
    eventType: string | undefined;
    /** User extended properties (Alchemy keys stripped from `private`). */
    extendedProperties: EventExtendedProperties | undefined;
    /** HTML link in Calendar. */
    htmlLink: string | undefined;
    /** iCalendar UID. */
    iCalUID: string | undefined;
    /** Hangout/Meet link. */
    hangoutLink: string | undefined;
    /** RFC3339 creation timestamp. */
    created: string | undefined;
    /** RFC3339 last-modified timestamp. */
    updated: string | undefined;
    /** ETag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Calendar event.
 *
 * Events stamp Alchemy ownership into `description` and private
 * extended properties for `list` / nuke. Parent calendar and event id
 * are identity — changing either replaces the event. Event type is
 * immutable after create. Summary, times, location, guests, and
 * reminders update in place.
 *
 * ### Creating an Event
 * **Example:** All-day event
 * ```typescript
 * const event = yield* GCP.Calendar.Event("Kickoff", {
 *   calendarId: cal.calendarId,
 *   summary: "Kickoff",
 *   start: { date: "2030-01-15" },
 *   end: { date: "2030-01-16" },
 * });
 * ```
 *
 * **Example:** Timed event
 * ```typescript
 * const event = yield* GCP.Calendar.Event("Standup", {
 *   calendarId: cal.calendarId,
 *   summary: "Standup",
 *   start: {
 *     dateTime: "2030-01-15T09:00:00Z",
 *     timeZone: "UTC",
 *   },
 *   end: {
 *     dateTime: "2030-01-15T09:30:00Z",
 *     timeZone: "UTC",
 *   },
 *   location: "Meet",
 * });
 * ```
 *
 * ### Updating an Event
 * **Example:** Change the title
 * ```typescript
 * const event = yield* GCP.Calendar.Event("Kickoff", {
 *   calendarId: existing.calendarId,
 *   eventId: existing.eventId,
 *   summary: "Kickoff (moved)",
 *   start: { date: "2030-01-16" },
 *   end: { date: "2030-01-17" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Calendar
 */
export const Event = Resource<Event>("GCP.Calendar.Event");

export class EventNotResolved extends Data.TaggedError(
  "GCP.Calendar.EventNotResolved",
)<{
  calendarId: string;
  eventId: string;
}> {}

const toAttrs = (
  event: calendar.Event,
  calendarId: string,
  project: string,
) => ({
  eventId: event.id ?? "",
  calendarId,
  project,
  summary: event.summary,
  description: parseOwnership(event.description).text,
  location: event.location,
  start: dateTimeOf(event.start),
  end: dateTimeOf(event.end),
  endTimeUnspecified: event.endTimeUnspecified,
  recurrence: event.recurrence,
  status: event.status,
  visibility: event.visibility,
  transparency: event.transparency,
  colorId: event.colorId,
  reminders: remindersOf(event.reminders),
  attendees: event.attendees,
  guestsCanInviteOthers: event.guestsCanInviteOthers,
  guestsCanModify: event.guestsCanModify,
  guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests,
  eventType: event.eventType,
  extendedProperties: extendedPropertiesOf(event.extendedProperties),
  htmlLink: event.htmlLink,
  iCalUID: event.iCalUID,
  hangoutLink: event.hangoutLink,
  created: event.created,
  updated: event.updated,
  etag: event.etag,
});

export const EventProvider = () =>
  Provider.succeed(Event, {
    stables: [
      "eventId",
      "calendarId",
      "project",
      "created",
      "iCalUID",
      "htmlLink",
      "eventType",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCalendar = olds?.calendarId ?? output?.calendarId;
      if (
        previousCalendar !== undefined &&
        news.calendarId !== previousCalendar
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.eventId ?? output?.eventId;
      if (
        previousId !== undefined &&
        news.eventId !== undefined &&
        news.eventId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousType = olds?.eventType ?? output?.eventType;
      if (
        previousType !== undefined &&
        news.eventType !== undefined &&
        news.eventType !== previousType
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const calendarId = olds?.calendarId ?? output?.calendarId ?? "";
      const eventId = olds?.eventId ?? output?.eventId ?? "";
      let existing = yield* getEvent(calendarId, eventId);
      if (existing === undefined) {
        existing = yield* findOwnedEvent(id, calendarId);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, calendarId, env.project);
      return (yield* eventOwnedByAlchemy(id, existing))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const events = yield* listOwnedEvents();
        return events
          .filter(hasAlchemyEventMarker)
          .map((event) => toAttrs(event, event.calendarId, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const calendarId = news.calendarId;
      const labels = yield* desiredEventPrivate(
        id,
        news.extendedProperties?.private,
      );
      const summary = yield* toGeneratedName(id, news.summary, output?.summary);
      const description = encodeOwnership(labels, news.description);
      const sendUpdates = news.sendUpdates ?? "none";
      const desired: calendar.Event = {
        id: news.eventId,
        summary,
        description,
        location: news.location,
        start: news.start,
        end: news.end,
        endTimeUnspecified: news.endTimeUnspecified,
        recurrence: news.recurrence,
        status: news.status,
        visibility: news.visibility,
        transparency: news.transparency,
        colorId: news.colorId,
        reminders: news.reminders,
        attendees: news.attendees,
        guestsCanInviteOthers: news.guestsCanInviteOthers,
        guestsCanModify: news.guestsCanModify,
        guestsCanSeeOtherGuests: news.guestsCanSeeOtherGuests,
        anyoneCanAddSelf: news.anyoneCanAddSelf,
        eventType: news.eventType,
        source: news.source,
        attachments: news.attachments,
        conferenceData: news.conferenceData,
        workingLocationProperties: news.workingLocationProperties,
        focusTimeProperties: news.focusTimeProperties,
        outOfOfficeProperties: news.outOfOfficeProperties,
        birthdayProperties: news.birthdayProperties,
        extendedProperties: {
          private: labels,
          shared: news.extendedProperties?.shared,
        },
      };

      let current = yield* getEvent(
        calendarId,
        news.eventId ?? output?.eventId ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedEvent(id, calendarId);
      }

      if (current === undefined) {
        const created = yield* calendar
          .insertEvents({
            calendarId,
            sendUpdates,
            conferenceDataVersion:
              news.conferenceData !== undefined ? 1 : undefined,
            supportsAttachments:
              news.attachments !== undefined ? true : undefined,
            body: desired,
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedEvent(id, calendarId)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EventNotResolved({
          calendarId,
          eventId: news.eventId ?? output?.eventId ?? summary,
        });
      }

      const eventId = current.id ?? news.eventId ?? output?.eventId ?? "";
      const summaryChanged = !sameText(current.summary, summary);
      const descriptionChanged = !sameText(current.description, description);
      const locationChanged =
        news.location !== undefined &&
        !sameText(current.location, news.location);
      const startChanged = !jsonEqual(dateTimeOf(current.start), news.start);
      const endChanged = !jsonEqual(dateTimeOf(current.end), news.end);
      const endUnspecifiedChanged =
        news.endTimeUnspecified !== undefined &&
        !sameBoolean(current.endTimeUnspecified, news.endTimeUnspecified);
      const recurrenceChanged =
        news.recurrence !== undefined &&
        !jsonEqual(current.recurrence, news.recurrence);
      const statusChanged =
        news.status !== undefined && !sameText(current.status, news.status);
      const visibilityChanged =
        news.visibility !== undefined &&
        !sameText(current.visibility, news.visibility);
      const transparencyChanged =
        news.transparency !== undefined &&
        !sameText(current.transparency, news.transparency);
      const colorChanged =
        news.colorId !== undefined && !sameText(current.colorId, news.colorId);
      const remindersChanged =
        news.reminders !== undefined &&
        !jsonEqual(remindersOf(current.reminders), news.reminders);
      const attendeesChanged =
        news.attendees !== undefined &&
        !jsonEqual(current.attendees, news.attendees);
      const inviteChanged =
        news.guestsCanInviteOthers !== undefined &&
        !sameBoolean(current.guestsCanInviteOthers, news.guestsCanInviteOthers);
      const modifyChanged =
        news.guestsCanModify !== undefined &&
        !sameBoolean(current.guestsCanModify, news.guestsCanModify);
      const seeChanged =
        news.guestsCanSeeOtherGuests !== undefined &&
        !sameBoolean(
          current.guestsCanSeeOtherGuests,
          news.guestsCanSeeOtherGuests,
        );
      const addSelfChanged =
        news.anyoneCanAddSelf !== undefined &&
        !sameBoolean(current.anyoneCanAddSelf, news.anyoneCanAddSelf);
      const sourceChanged =
        news.source !== undefined && !jsonEqual(current.source, news.source);
      const attachmentsChanged =
        news.attachments !== undefined &&
        !jsonEqual(current.attachments, news.attachments);
      const conferenceChanged =
        news.conferenceData !== undefined &&
        !jsonEqual(current.conferenceData, news.conferenceData);
      const workingChanged =
        news.workingLocationProperties !== undefined &&
        !jsonEqual(
          current.workingLocationProperties,
          news.workingLocationProperties,
        );
      const focusChanged =
        news.focusTimeProperties !== undefined &&
        !jsonEqual(current.focusTimeProperties, news.focusTimeProperties);
      const oooChanged =
        news.outOfOfficeProperties !== undefined &&
        !jsonEqual(current.outOfOfficeProperties, news.outOfOfficeProperties);
      const birthdayChanged =
        news.birthdayProperties !== undefined &&
        !jsonEqual(current.birthdayProperties, news.birthdayProperties);
      const privateChanged = !jsonEqual(
        tagRecord(current.extendedProperties?.private),
        labels,
      );
      const sharedChanged =
        news.extendedProperties?.shared !== undefined &&
        !jsonEqual(
          current.extendedProperties?.shared,
          news.extendedProperties.shared,
        );

      if (
        summaryChanged ||
        descriptionChanged ||
        locationChanged ||
        startChanged ||
        endChanged ||
        endUnspecifiedChanged ||
        recurrenceChanged ||
        statusChanged ||
        visibilityChanged ||
        transparencyChanged ||
        colorChanged ||
        remindersChanged ||
        attendeesChanged ||
        inviteChanged ||
        modifyChanged ||
        seeChanged ||
        addSelfChanged ||
        sourceChanged ||
        attachmentsChanged ||
        conferenceChanged ||
        workingChanged ||
        focusChanged ||
        oooChanged ||
        birthdayChanged ||
        privateChanged ||
        sharedChanged
      ) {
        current = yield* calendar.patchEvents({
          calendarId,
          eventId,
          sendUpdates,
          conferenceDataVersion:
            news.conferenceData !== undefined ? 1 : undefined,
          supportsAttachments:
            news.attachments !== undefined ? true : undefined,
          body: desired,
        });
      }

      const fresh = yield* getEvent(calendarId, eventId);
      return toAttrs(fresh ?? current, calendarId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.calendarId.length === 0 || output.eventId.length === 0) {
        return;
      }
      yield* ignoreMissing(
        calendar.deleteEvents({
          calendarId: output.calendarId,
          eventId: output.eventId,
          sendUpdates: "none",
        }),
      );
    }),
  });
