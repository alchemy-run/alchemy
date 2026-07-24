import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

/**
 * A contact's subscription preference for a single topic. Pass the distilled
 * shape directly: `TopicName` and a `SubscriptionStatus` of `"OPT_IN"` or
 * `"OPT_OUT"`.
 */
export type ContactTopicPreference = sesv2.TopicPreference;

export interface ContactProps {
  /**
   * Name of the contact list this contact belongs to. Typically the
   * `contactListName` output of a `SES.ContactList`. Changing it replaces the
   * contact.
   */
  contactListName: string;
  /**
   * The contact's email address — the stable identifier within the list.
   * Changing it replaces the contact.
   */
  emailAddress: string;
  /**
   * The contact's per-topic subscription preferences. `updateContact` does a
   * complete replacement, so the full desired set is sent on every change.
   */
  topicPreferences?: ContactTopicPreference[];
  /**
   * Whether the contact is unsubscribed from all topics.
   * @default false
   */
  unsubscribeAll?: boolean;
  /**
   * Arbitrary application metadata attached to the contact, as a JSON string.
   */
  attributesData?: string;
}

export interface Contact extends Resource<
  "AWS.SES.Contact",
  ContactProps,
  {
    /** Name of the contact list the contact belongs to. */
    contactListName: string;
    /** The contact's email address. */
    emailAddress: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon SES v2 contact — a single email address on a `SES.ContactList`,
 * with its own topic subscription preferences and unsubscribe state.
 * @resource
 * @section Adding Contacts
 * @example Basic Contact
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const list = yield* SES.ContactList("Newsletter", {});
 * const contact = yield* SES.Contact("Subscriber", {
 *   contactListName: list.contactListName,
 *   emailAddress: "reader@example.com",
 * });
 * ```
 *
 * @example Contact with Topic Preferences
 * ```typescript
 * const contact = yield* SES.Contact("Subscriber", {
 *   contactListName: list.contactListName,
 *   emailAddress: "reader@example.com",
 *   topicPreferences: [
 *     { TopicName: "product-updates", SubscriptionStatus: "OPT_IN" },
 *     { TopicName: "promotions", SubscriptionStatus: "OPT_OUT" },
 *   ],
 * });
 * ```
 */
export const Contact = Resource<Contact>("AWS.SES.Contact");

const samePreferences = (
  a: ReadonlyArray<ContactTopicPreference> | undefined,
  b: ReadonlyArray<ContactTopicPreference> | undefined,
): boolean => {
  const key = (prefs: ReadonlyArray<ContactTopicPreference> | undefined) =>
    JSON.stringify(
      [...(prefs ?? [])]
        .map((p) => ({
          TopicName: p.TopicName,
          SubscriptionStatus: p.SubscriptionStatus,
        }))
        .sort((x, y) => x.TopicName.localeCompare(y.TopicName)),
    );
  return key(a) === key(b);
};

export const ContactProvider = () =>
  Provider.effect(
    Contact,
    Effect.gen(function* () {
      const getContact = Effect.fn(function* (
        contactListName: string,
        emailAddress: string,
      ) {
        return yield* sesv2
          .getContact({
            ContactListName: contactListName,
            EmailAddress: emailAddress,
          })
          .pipe(
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      return Contact.Provider.of({
        stables: ["contactListName", "emailAddress"],

        // Contacts are keyed by their parent list; there is no flat
        // account-level enumeration, and deleting the list removes its
        // contacts, so nuke handles them via the parent contact list.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const contactListName =
            output?.contactListName ?? olds?.contactListName;
          const emailAddress = output?.emailAddress ?? olds?.emailAddress;
          if (contactListName === undefined || emailAddress === undefined) {
            return undefined;
          }
          const found = yield* getContact(contactListName, emailAddress);
          // Contacts carry no tags, so existence at the (list, email) key is
          // treated as ownership.
          return found ? { contactListName, emailAddress } : undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.contactListName !== olds.contactListName ||
            news.emailAddress !== olds.emailAddress
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          const contactListName =
            output?.contactListName ?? news.contactListName;
          const emailAddress = output?.emailAddress ?? news.emailAddress;

          // 1. OBSERVE — cloud state is authoritative.
          const observed = yield* getContact(contactListName, emailAddress);

          if (observed === undefined) {
            // 2. ENSURE — create; AlreadyExists is a race → converge via update.
            yield* sesv2
              .createContact({
                ContactListName: contactListName,
                EmailAddress: emailAddress,
                TopicPreferences: news.topicPreferences,
                UnsubscribeAll: news.unsubscribeAll,
                AttributesData: news.attributesData,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  sesv2.updateContact({
                    ContactListName: contactListName,
                    EmailAddress: emailAddress,
                    TopicPreferences: news.topicPreferences,
                    UnsubscribeAll: news.unsubscribeAll,
                    AttributesData: news.attributesData,
                  }),
                ),
              );
          } else if (
            (observed.UnsubscribeAll ?? false) !==
              (news.unsubscribeAll ?? false) ||
            observed.AttributesData !== news.attributesData ||
            !samePreferences(observed.TopicPreferences, news.topicPreferences)
          ) {
            // 3. SYNC — updateContact is a complete replacement of the
            //    preferences and metadata.
            yield* sesv2.updateContact({
              ContactListName: contactListName,
              EmailAddress: emailAddress,
              TopicPreferences: news.topicPreferences,
              UnsubscribeAll: news.unsubscribeAll,
              AttributesData: news.attributesData,
            });
          }

          return { contactListName, emailAddress };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteContact is idempotent for a missing contact; a missing list
          // means the contact is already gone.
          yield* sesv2
            .deleteContact({
              ContactListName: output.contactListName,
              EmailAddress: output.emailAddress,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
