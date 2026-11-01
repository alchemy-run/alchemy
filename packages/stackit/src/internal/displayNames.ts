/**
 * Shared scaffolding of the APIs that identify objects by a generated id and name
 * them with a short `displayName`, paged by `pageToken` (Telemetry Router, Intake).
 * Not exported from any namespace barrel.
 */
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { hasAlchemyLabels, hasInstanceLabel } from "../Labels.ts";
import { isGeneratedPhysicalName } from "./names.ts";

/** A display name is at most 32 characters on these APIs. */
export const DISPLAY_NAME_MAX_LENGTH = 32;

/** Largest page these APIs serve (the specs' `pageSize` maximum). */
export const MAX_PAGE_SIZE = 100;

/** Pages a list may run to: 100,000 objects, far past any real project. */
const MAX_PAGES = 1000;

/** Physical name for an object with a display name: letters, digits and hyphens. */
export const generatedDisplayName = (id: string) =>
  createPhysicalName({ id, maxLength: DISPLAY_NAME_MAX_LENGTH, lowercase: true });

/** Whether a display name has the shape {@link generatedDisplayName} produces. */
export const isGeneratedDisplayName = (name: string): boolean =>
  isGeneratedPhysicalName(name, DISPLAY_NAME_MAX_LENGTH);

/** A list didn't end within its page bound. Fails rather than returning part of the list. */
export class StackitListTooLong extends Data.TaggedError("Stackit.ListTooLong")<{
  readonly resource: string;
  readonly message: string;
}> {}

/**
 * Fetch every page of a list that pages by `nextPageToken`. These operations have no
 * pagination trait in distilled, and the default page holds only ten objects.
 */
export const collectTokenPages = <P extends { readonly nextPageToken?: string }, A, E, R>(
  resource: string,
  fetchPage: (pageToken: string | undefined) => Effect.Effect<P, E, R>,
  itemsOf: (page: P) => ReadonlyArray<A>,
): Effect.Effect<A[], E | StackitListTooLong, R> =>
  Effect.gen(function* () {
    const items: A[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* fetchPage(pageToken);
      items.push(...itemsOf(response));
      pageToken = response.nextPageToken;
      if (pageToken === undefined || pageToken === "") return items;
    }
    return yield* new StackitListTooLong({
      resource,
      message: `Listing ${resource} didn't end within ${MAX_PAGES} pages`,
    });
  });

/**
 * The first object carrying this logical id's ownership labels, and when `generation`
 * is set, that generation's instance label: a replacement shares its logical id with
 * the object it replaces, and must never claim it.
 */
export const findOwnedGeneration = <A>(
  id: string,
  generation: string | undefined,
  items: ReadonlyArray<A>,
  labelsOf: (item: A) => unknown,
) =>
  Effect.gen(function* () {
    for (const item of items) {
      if (generation !== undefined && !hasInstanceLabel(generation, labelsOf(item))) continue;
      if (yield* hasAlchemyLabels(id, labelsOf(item))) return item;
    }
    return undefined;
  });

/**
 * The 409 these APIs document is "the resource has been modified by some other
 * client, please try again": it clears by itself. Bounded to under a minute.
 */
export const conflictRetry = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.spaced("5 seconds"),
  times: 10,
} as const;

/** An API echoes an unset text as empty. */
export const emptyToUndefined = (value: string | undefined | null): string | undefined =>
  value === undefined || value === null || value === "" ? undefined : value;
