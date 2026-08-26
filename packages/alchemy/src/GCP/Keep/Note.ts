import * as keep from "@distilled.cloud/gcp/keep_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  desiredBody,
  encodeOwnershipLine,
  findOwnedNote,
  fromListItems,
  getNote,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listOwnedNotes,
  MAX_TITLE_LENGTH,
  normalizeEmails,
  noteIdOf,
  noteNameOf,
  ownedByAlchemy,
  ownershipLabels,
  parseOwnership,
  sameText,
  toGeneratedName,
  writerEmails,
  writerPermissionNames,
  type ListItemProps,
} from "./internal.ts";

export type { ListItemProps };

export type NoteProps = {
  /**
   * Resource name `notes/{note}` or the `{note}` id. Server-assigned
   * on create. Immutable — changing it replaces the note.
   */
  name?: string;
  /**
   * Note title (max 1,000 characters including Alchemy's ownership
   * marker). Keep notes have no labels field, so ownership is stored
   * in a `[alchemy …]` prefix and stripped from attributes. The Keep
   * API cannot update title after create — changing it replaces the
   * note.
   */
  title?: string;
  /**
   * Plain-text body (max 20,000 characters). Mutually exclusive with
   * `listItems`. Changing it replaces the note.
   */
  text?: string;
  /**
   * Checklist body. Mutually exclusive with `text`. Changing it
   * replaces the note.
   */
  listItems?: ListItemProps[];
  /**
   * Emails granted the `WRITER` role. Owner is always present and
   * cannot be removed. Omitted means leave collaborators unchanged.
   */
  writers?: string[];
};

export type Note = Resource<
  "GCP.Keep.Note",
  NoteProps,
  {
    /** Resource name `notes/{note}`. */
    name: string;
    /** Note id (last path segment). */
    noteId: string;
    /** Project id used when the note was reconciled. */
    project: string;
    /** User-facing title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
    /** Plain-text body, if this is a text note. */
    text: string | undefined;
    /** Checklist items, if this is a list note. */
    listItems: ListItemProps[] | undefined;
    /** Collaborator emails with the `WRITER` role. */
    writers: string[];
    /** Whether the note is in the trash. */
    trashed: boolean | undefined;
    /** RFC3339 create timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-modification timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Keep note.
 *
 * Notes have no labels field, so Alchemy stamps ownership into `title`
 * for `list` / nuke. Resource name, title, and body are identity —
 * Keep has no update API for those fields, so changing them replaces
 * the note. Collaborator `writers` sync in place via
 * `permissions.batchCreate` / `permissions.batchDelete`. Creating notes
 * as a service account is not supported; use a user OAuth token with
 * the `https://www.googleapis.com/auth/keep` scope or domain-wide
 * delegation.
 *
 * ### Creating a Note
 * **Example:** Text note
 * ```typescript
 * const note = yield* GCP.Keep.Note("Scratch", {
 *   title: "Standup",
 *   text: "Ship the Keep provider",
 * });
 * ```
 *
 * **Example:** Checklist
 * ```typescript
 * const note = yield* GCP.Keep.Note("Todos", {
 *   title: "Launch",
 *   listItems: [
 *     { text: "Write tests", checked: true },
 *     { text: "Register the provider" },
 *   ],
 * });
 * ```
 *
 * ### Replacing a Note
 * **Example:** New title (replaces — Keep cannot patch title)
 * ```typescript
 * const note = yield* GCP.Keep.Note("Scratch", {
 *   title: "Retro",
 *   text: "Ship the Keep provider",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Keep
 */
export const Note = Resource<Note>("GCP.Keep.Note");

export class NoteNotResolved extends Data.TaggedError(
  "GCP.Keep.NoteNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (note: keep.Note, project: string) => ({
  name: noteNameOf(note.name),
  noteId: noteIdOf(note.name),
  project,
  title: parseOwnership(note.title).text,
  text: note.body?.text?.text,
  listItems: fromListItems(note.body?.list?.listItems),
  writers: writerEmails(note),
  trashed: note.trashed,
  createTime: note.createTime,
  updateTime: note.updateTime,
});

export const NoteProvider = () =>
  Provider.succeed(Note, {
    stables: ["name", "noteId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = noteNameOf(olds?.name ?? output?.name);
      const nextName = noteNameOf(news.name);
      if (
        previousName.length > 0 &&
        nextName.length > 0 &&
        previousName !== nextName
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousTitle = olds?.title ?? output?.title;
      if (
        news.title !== undefined &&
        (olds !== undefined || output !== undefined) &&
        !sameText(news.title, previousTitle)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousText = olds?.text ?? output?.text;
      if (
        news.text !== undefined &&
        (olds !== undefined || output !== undefined) &&
        !sameText(news.text, previousText)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousList = olds?.listItems ?? output?.listItems;
      if (
        news.listItems !== undefined &&
        (olds !== undefined || output !== undefined) &&
        !jsonEqual(news.listItems, previousList ?? [])
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      let existing = yield* getNote(olds?.name ?? output?.name ?? "");
      if (existing === undefined) {
        existing = yield* findOwnedNote(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.title))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedNotes();
        return items
          .filter((item) => hasOwnershipMarker(item.title))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const labels = yield* ownershipLabels(id);
      const displayTitle = yield* toGeneratedName(
        id,
        news.title,
        output?.title,
      );
      const title = encodeOwnershipLine(labels, displayTitle, MAX_TITLE_LENGTH);

      let current = yield* getNote(news.name ?? output?.name ?? "");
      if (current === undefined) {
        current = yield* findOwnedNote(id);
      }

      if (current === undefined) {
        const body = desiredBody(news, undefined) ?? {
          text: { text: "" },
        };
        const created = yield* keep
          .createNotes({
            body: {
              title,
              body,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedNote(id)));
        current = created ?? undefined;
      }

      if (current === undefined || !current.name) {
        return yield* new NoteNotResolved({
          name: news.name ?? output?.name ?? title,
        });
      }

      const name = noteNameOf(current.name);
      if (news.writers !== undefined) {
        const desired = new Set(normalizeEmails(news.writers));
        const observed = new Set(writerEmails(current));
        const toAdd = [...desired].filter((email) => !observed.has(email));
        const toRemove = [...observed].filter((email) => !desired.has(email));
        if (toAdd.length > 0) {
          yield* keep
            .batchCreateNotesPermissions({
              parent: name,
              body: {
                requests: toAdd.map((email) => ({
                  parent: name,
                  permission: { email, role: "WRITER" },
                })),
              },
            })
            .pipe(
              Effect.catchTag("Conflict", () => Effect.void),
              Effect.catchTag("BadRequest", () => Effect.void),
            );
        }
        const removeNames = writerPermissionNames(current, new Set(toRemove));
        if (removeNames.length > 0) {
          yield* keep
            .batchDeleteNotesPermissions({
              parent: name,
              body: { names: removeNames },
            })
            .pipe(Effect.catchTag("BadRequest", () => Effect.void));
        }
        if (toAdd.length > 0 || removeNames.length > 0) {
          current = (yield* getNote(name)) ?? current;
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const name = noteNameOf(output.name);
      if (name.length === 0) return;
      yield* ignoreMissing(keep.deleteNotes({ name }));
    }),
  });
