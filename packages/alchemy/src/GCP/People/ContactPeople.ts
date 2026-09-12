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
  biographyOf,
  emailsOf,
  findOwnedContactPerson,
  getContactPerson,
  ignoreMissing,
  jsonEqual,
  listOwnedContactPeople,
  membershipsOf,
  mergeOwnershipClientData,
  nameOf,
  ownershipLabels,
  PERSON_FIELDS,
  personOwnedByAlchemy,
  phonesOf,
  toGeneratedName,
  toMemberships,
  userClientData,
} from "./internal.ts";

export type ContactPeopleClientDataItem = {
  /** Client-specified key. */
  key: string;
  /** Client-specified value. */
  value: string;
};

export type ContactPeopleEmail = {
  /** Email address. */
  value: string;
  /** Type (`home`, `work`, `other`, or custom). */
  type?: string;
  /** Display name of the email. */
  displayName?: string;
};

export type ContactPeoplePhone = {
  /** Phone number. */
  value: string;
  /** Type (`home`, `work`, `mobile`, or custom). */
  type?: string;
};

export type ContactPeopleProps = {
  /**
   * Server-assigned resource name `people/{id}`. Immutable — changing
   * it replaces the contact.
   */
  resourceName?: string;
  /**
   * Given name. If omitted, a unique name is generated from the stack,
   * stage, and logical id. Names are a singleton for contact sources.
   */
  givenName?: string;
  /**
   * Family name.
   */
  familyName?: string;
  /**
   * Middle name(s).
   */
  middleName?: string;
  /**
   * Honorific prefix, such as `Dr.` or `Mrs.`
   */
  honorificPrefix?: string;
  /**
   * Honorific suffix, such as `Jr.`
   */
  honorificSuffix?: string;
  /**
   * Free-form unstructured name.
   */
  unstructuredName?: string;
  /**
   * Email addresses. Omitted on update leaves existing emails in place;
   * an empty array clears them.
   */
  emails?: ContactPeopleEmail[];
  /**
   * Phone numbers. Omitted on update leaves existing numbers in place;
   * an empty array clears them.
   */
  phoneNumbers?: ContactPeoplePhone[];
  /**
   * Contact group resource names (`contactGroups/{id}`). Omitted on
   * update leaves memberships in place. An empty array keeps the
   * contact in `contactGroups/myContacts`.
   */
  memberships?: string[];
  /**
   * Short biography (singleton for contact sources).
   */
  biography?: string;
  /**
   * Extra client data. Alchemy ownership keys (`alchemy-stack`,
   * `alchemy-stage`, `alchemy-id`) are merged in automatically because
   * contacts have no labels field.
   */
  clientData?: ContactPeopleClientDataItem[];
};

export type ContactPeople = Resource<
  "GCP.People.ContactPeople",
  ContactPeopleProps,
  {
    /** Server-assigned resource name `people/{id}`. */
    resourceName: string;
    /** Project id used when the contact was reconciled. */
    project: string;
    /** Given name. */
    givenName: string | undefined;
    /** Family name. */
    familyName: string | undefined;
    /** Middle name(s). */
    middleName: string | undefined;
    /** Honorific prefix. */
    honorificPrefix: string | undefined;
    /** Honorific suffix. */
    honorificSuffix: string | undefined;
    /** Unstructured name. */
    unstructuredName: string | undefined;
    /** Display name from the People API. */
    displayName: string | undefined;
    /** Email addresses. */
    emails: ContactPeopleEmail[];
    /** Phone numbers. */
    phoneNumbers: ContactPeoplePhone[];
    /** Contact group resource names. */
    memberships: string[];
    /** Biography text. */
    biography: string | undefined;
    /** ETag. */
    etag: string | undefined;
    /** User client data (Alchemy ownership keys stripped). */
    clientData: ContactPeopleClientDataItem[];
  },
  never,
  Providers
>;

/**
 * A Google Contacts person (a contact in the authenticated user's
 * grouped contacts).
 *
 * Contacts have no labels field, so Alchemy stamps ownership into
 * `clientData` for `list` / nuke. The resource name is identity —
 * changing it replaces the contact. Name, emails, phones, biography,
 * memberships, and client data update in place. Creating contacts as a
 * service account requires a user OAuth token with the
 * `https://www.googleapis.com/auth/contacts` scope (or domain-wide
 * delegation).
 *
 * ### Creating a Contact
 * **Example:** Generated given name
 * ```typescript
 * const person = yield* GCP.People.ContactPeople("Ada", {});
 * ```
 *
 * **Example:** Named contact with email
 * ```typescript
 * const person = yield* GCP.People.ContactPeople("Ada", {
 *   givenName: "Ada",
 *   familyName: "Lovelace",
 *   emails: [{ value: "ada@example.com", type: "work" }],
 * });
 * ```
 *
 * ### Updating a Contact
 * **Example:** Rename and add a phone
 * ```typescript
 * const person = yield* GCP.People.ContactPeople("Ada", {
 *   resourceName: existing.resourceName,
 *   givenName: "Ada",
 *   familyName: "Byron",
 *   phoneNumbers: [{ value: "+1-555-0100", type: "mobile" }],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category People
 */
export const ContactPeople = Resource<ContactPeople>(
  "GCP.People.ContactPeople",
);

export class ContactPeopleNotResolved extends Data.TaggedError(
  "GCP.People.ContactPeopleNotResolved",
)<{
  resourceName: string;
}> {}

const toAttrs = (person: people.Person, project: string) => {
  const name = nameOf(person.names);
  return {
    resourceName: person.resourceName ?? "",
    project,
    givenName: name?.givenName,
    familyName: name?.familyName,
    middleName: name?.middleName,
    honorificPrefix: name?.honorificPrefix,
    honorificSuffix: name?.honorificSuffix,
    unstructuredName: name?.unstructuredName,
    displayName: person.names?.[0]?.displayName,
    emails: emailsOf(person.emailAddresses),
    phoneNumbers: phonesOf(person.phoneNumbers),
    memberships: membershipsOf(person.memberships),
    biography: biographyOf(person.biographies),
    etag: person.etag,
    clientData: userClientData(person.clientData),
  };
};

const desiredName = (
  news: ContactPeopleProps,
  current: people.Person | undefined,
  generatedGivenName: string,
): people.Name => ({
  givenName:
    news.givenName ?? current?.names?.[0]?.givenName ?? generatedGivenName,
  familyName: news.familyName ?? current?.names?.[0]?.familyName,
  middleName: news.middleName ?? current?.names?.[0]?.middleName,
  honorificPrefix: news.honorificPrefix ?? current?.names?.[0]?.honorificPrefix,
  honorificSuffix: news.honorificSuffix ?? current?.names?.[0]?.honorificSuffix,
  unstructuredName:
    news.unstructuredName ?? current?.names?.[0]?.unstructuredName,
});

export const ContactPeopleProvider = () =>
  Provider.succeed(ContactPeople, {
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
      let existing = yield* getContactPerson(resourceName);
      if (existing === undefined) {
        existing = yield* findOwnedContactPerson(id);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* personOwnedByAlchemy(id, existing))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedContactPeople();
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* ownershipLabels(id);
      const generatedGivenName = yield* toGeneratedName(
        id,
        news.givenName,
        output?.givenName,
      );
      const clientData = mergeOwnershipClientData(news.clientData, ownership);

      let current = yield* getContactPerson(
        news.resourceName ?? output?.resourceName ?? "",
      );
      if (current === undefined) {
        current = yield* findOwnedContactPerson(id);
      }

      if (current === undefined) {
        const names = [desiredName(news, undefined, generatedGivenName)];
        const created = yield* people
          .createContactPeople({
            personFields: PERSON_FIELDS,
            sources: ["READ_SOURCE_TYPE_CONTACT"],
            body: {
              names,
              emailAddresses: news.emails,
              phoneNumbers: news.phoneNumbers,
              clientData,
              biographies:
                news.biography !== undefined
                  ? [{ value: news.biography, contentType: "TEXT_PLAIN" }]
                  : undefined,
              memberships: toMemberships(news.memberships),
            },
          })
          .pipe(Effect.catchTag("Conflict", () => findOwnedContactPerson(id)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new ContactPeopleNotResolved({
          resourceName:
            news.resourceName ?? output?.resourceName ?? generatedGivenName,
        });
      }

      const resourceName =
        current.resourceName ?? news.resourceName ?? output?.resourceName ?? "";
      const nextName = desiredName(news, current, generatedGivenName);
      const nextEmails = news.emails ?? emailsOf(current.emailAddresses);
      const nextPhones = news.phoneNumbers ?? phonesOf(current.phoneNumbers);
      const nextMemberships =
        news.memberships ?? membershipsOf(current.memberships);
      const nextBiography = news.biography ?? biographyOf(current.biographies);
      const nextClientData = clientData;

      const nameChanged = !jsonEqual(nameOf(current.names), nextName);
      const emailsChanged =
        news.emails !== undefined &&
        !jsonEqual(emailsOf(current.emailAddresses), nextEmails);
      const phonesChanged =
        news.phoneNumbers !== undefined &&
        !jsonEqual(phonesOf(current.phoneNumbers), nextPhones);
      const membershipsChanged =
        news.memberships !== undefined &&
        !jsonEqual(
          membershipsOf(current.memberships),
          [...nextMemberships].sort(),
        );
      const biographyChanged =
        news.biography !== undefined &&
        !jsonEqual(biographyOf(current.biographies), nextBiography);
      const clientDataChanged = !jsonEqual(
        mergeOwnershipClientData(userClientData(current.clientData), ownership),
        nextClientData,
      );

      if (
        nameChanged ||
        emailsChanged ||
        phonesChanged ||
        membershipsChanged ||
        biographyChanged ||
        clientDataChanged
      ) {
        const updatePersonFields = [
          "names",
          "clientData",
          news.emails !== undefined ? "emailAddresses" : undefined,
          news.phoneNumbers !== undefined ? "phoneNumbers" : undefined,
          news.memberships !== undefined ? "memberships" : undefined,
          news.biography !== undefined ? "biographies" : undefined,
        ]
          .filter((field): field is string => field !== undefined)
          .join(",");
        current = yield* people.updateContactPeople({
          resourceName,
          updatePersonFields,
          personFields: PERSON_FIELDS,
          sources: ["READ_SOURCE_TYPE_CONTACT"],
          body: {
            resourceName,
            etag: current.etag,
            metadata: current.metadata,
            names: [nextName],
            clientData: nextClientData,
            emailAddresses: news.emails !== undefined ? nextEmails : undefined,
            phoneNumbers:
              news.phoneNumbers !== undefined ? nextPhones : undefined,
            memberships:
              news.memberships !== undefined
                ? toMemberships(nextMemberships)
                : undefined,
            biographies:
              news.biography !== undefined
                ? [{ value: nextBiography, contentType: "TEXT_PLAIN" }]
                : undefined,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.resourceName.length === 0) return;
      yield* ignoreMissing(
        people.deleteContactPeople({
          resourceName: output.resourceName,
        }),
      );
    }),
  });
