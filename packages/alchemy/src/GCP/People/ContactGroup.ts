import * as people from "@distilled.cloud/gcp/people_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnershipLine,
  findOwnedContactGroup,
  getContactGroup,
  GROUP_FIELDS,
  groupOwnedByAlchemy,
  hasAlchemyClientData,
  hasOwnershipMarker,
  ignoreMissing,
  jsonEqual,
  listOwnedContactGroups,
  MAX_GROUP_NAME_LENGTH,
  mergeOwnershipClientData,
  ownershipLabels,
  parseOwnership,
  sameText,
  toGeneratedName,
  userClientData,
} from "./internal.ts";

export type ContactGroupClientDataItem = {
  /** Client-specified key. */
  key: string;
  /** Client-specified value. */
  value: string;
};

export type ContactGroupProps = {
  /**
   * Server-assigned resource name `contactGroups/{id}`. Immutable —
   * changing it replaces the group.
   */
  resourceName?: string;
  /**
   * Display name. Contact groups have no labels field, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and `clientData`,
   * then strips the prefix from attributes. Names must be unique
   * among the user's groups.
   */
  name?: string;
  /**
   * Extra client data. Alchemy ownership keys (`alchemy-stack`,
   * `alchemy-stage`, `alchemy-id`) are merged in automatically.
   */
  clientData?: ContactGroupClientDataItem[];
};

export type ContactGroup = Resource<
  "GCP.People.ContactGroup",
  ContactGroupProps,
  {
    /** Server-assigned resource name `contactGroups/{id}`. */
    resourceName: string;
    /** Project id used when the group was reconciled. */
    project: string;
    /** User-facing name with the Alchemy ownership prefix stripped. */
    name: string | undefined;
    /** Formatted name. */
    formattedName: string | undefined;
    /** Group type (`USER_CONTACT_GROUP` or `SYSTEM_CONTACT_GROUP`). */
    groupType: string | undefined;
    /** Member count. */
    memberCount: number | undefined;
    /** Member person resource names, when requested. */
    memberResourceNames: string[] | undefined;
    /** ETag. */
    etag: string | undefined;
    /** User client data (Alchemy ownership keys stripped). */
    clientData: ContactGroupClientDataItem[];
  },
  never,
  Providers
>;

/**
 * A Google Contacts contact group.
 *
 * Contact groups have no labels field, so Alchemy stamps ownership into
 * `name` and `clientData` for `list` / nuke. The resource name is
 * identity — changing it replaces the group. Display name and client
 * data update in place. Creating groups as a service account requires
 * a user OAuth token with the `https://www.googleapis.com/auth/contacts`
 * scope (or domain-wide delegation).
 *
 * ### Creating a Contact Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.People.ContactGroup("Friends", {});
 * ```
 *
 * **Example:** Explicit name
 * ```typescript
 * const group = yield* GCP.People.ContactGroup("Friends", {
 *   name: "Alchemy Friends",
 * });
 * ```
 *
 * ### Updating a Contact Group
 * **Example:** Rename
 * ```typescript
 * const group = yield* GCP.People.ContactGroup("Friends", {
 *   resourceName: existing.resourceName,
 *   name: "Alchemy Friends v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category People
 */
export const ContactGroup = Resource<ContactGroup>("GCP.People.ContactGroup");

export class ContactGroupNotResolved extends Data.TaggedError(
  "GCP.People.ContactGroupNotResolved",
)<{
  resourceName: string;
}> {}

const toAttrs = (group: people.ContactGroup, project: string) => ({
  resourceName: group.resourceName ?? "",
  project,
  name: parseOwnership(group.name).text,
  formattedName: group.formattedName,
  groupType: group.groupType,
  memberCount: group.memberCount,
  memberResourceNames: group.memberResourceNames,
  etag: group.etag,
  clientData: userClientData(group.clientData),
});

export const ContactGroupProvider = () =>
  Provider.succeed(ContactGroup, {
    stables: ["resourceName", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.resourceName ?? output?.resourceName;
      if (
        previous !== undefined &&
        news.resourceName !== undefined &&
        news.resourceName !== previous
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const resourceName = olds?.resourceName ?? output?.resourceName ?? "";
      let existing = yield* getContactGroup(resourceName);
      if (existing === undefined) {
        const ownership = yield* ownershipLabels(id);
        const name = encodeOwnershipLine(
          ownership,
          olds?.name ?? output?.name,
          MAX_GROUP_NAME_LENGTH,
        );
        existing = yield* findOwnedContactGroup(id, name);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* groupOwnedByAlchemy(id, existing))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedContactGroups();
        return items
          .filter(
            (item) =>
              hasOwnershipMarker(item.name) ||
              hasAlchemyClientData(item.clientData),
          )
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* ownershipLabels(id);
      const displayName = yield* toGeneratedName(id, news.name, output?.name);
      const name = encodeOwnershipLine(
        ownership,
        displayName,
        MAX_GROUP_NAME_LENGTH,
      );
      const clientData = mergeOwnershipClientData(news.clientData, ownership);

      let current = yield* getContactGroup(
        news.resourceName ?? output?.resourceName ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedContactGroup(id, name);
      }

      if (current === undefined) {
        const created = yield* people
          .createContactGroups({
            body: {
              contactGroup: {
                name,
                clientData,
              },
              readGroupFields: GROUP_FIELDS,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => findOwnedContactGroup(id, name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContactGroupNotResolved({
          resourceName: news.resourceName ?? output?.resourceName ?? name,
        });
      }

      const resourceName =
        current.resourceName ?? news.resourceName ?? output?.resourceName ?? "";
      const nameChanged = !sameText(current.name, name);
      const clientDataChanged = !jsonEqual(
        mergeOwnershipClientData(userClientData(current.clientData), ownership),
        clientData,
      );

      if (nameChanged || clientDataChanged) {
        current = yield* people.updateContactGroups({
          resourceName,
          body: {
            contactGroup: {
              resourceName,
              etag: current.etag,
              name,
              clientData,
            },
            updateGroupFields: "name,clientData",
            readGroupFields: GROUP_FIELDS,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.resourceName.length === 0) return;
      if (output.groupType === "SYSTEM_CONTACT_GROUP") return;
      yield* ignoreMissing(
        people.deleteContactGroups({
          resourceName: output.resourceName,
        }),
      );
    }),
  });
