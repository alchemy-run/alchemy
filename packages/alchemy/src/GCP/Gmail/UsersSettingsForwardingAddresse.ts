import * as gmail from "@distilled.cloud/gcp/gmail_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_USER,
  getForwardingAddress,
  ignoreMissing,
  isAlchemyEmail,
  listForwardingAddresses,
  sameText,
  toUserId,
} from "./internal.ts";

export type UsersSettingsForwardingAddresseProps = {
  /**
   * Mailbox to manage. Email address or `"me"`.
   * @default "me"
   */
  userId?: string;
  /**
   * Address messages can be forwarded to. Identity — changing it
   * replaces the forwarding address.
   */
  forwardingEmail: string;
};

export type UsersSettingsForwardingAddresse = Resource<
  "GCP.Gmail.UsersSettingsForwardingAddresse",
  UsersSettingsForwardingAddresseProps,
  {
    /** Forwarding email. */
    forwardingEmail: string;
    /** Mailbox the address belongs to. */
    userId: string;
    /** Project id used when the address was reconciled. */
    project: string;
    /** Verification status. */
    verificationStatus: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail forwarding address.
 *
 * Forwarding addresses have no labels or description, so identity is
 * `(userId, forwardingEmail)` and `list` / nuke returns rows whose
 * email local-part starts with `alchemy-`. There is nothing mutable
 * beyond identity. Create requires domain-wide delegation.
 *
 * ### Creating a Forwarding Address
 * **Example:** Add a forwarding address
 * ```typescript
 * const address = yield* GCP.Gmail.UsersSettingsForwardingAddresse("Backup", {
 *   forwardingEmail: "backup@example.com",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersSettingsForwardingAddresse =
  Resource<UsersSettingsForwardingAddresse>(
    "GCP.Gmail.UsersSettingsForwardingAddresse",
  );

export class UsersSettingsForwardingAddresseNotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersSettingsForwardingAddresseNotResolved",
)<{
  userId: string;
  forwardingEmail: string;
}> {}

const toAttrs = (
  address: gmail.ForwardingAddress,
  userId: string,
  project: string,
) => ({
  forwardingEmail: address.forwardingEmail ?? "",
  userId,
  project,
  verificationStatus: address.verificationStatus,
});

export const UsersSettingsForwardingAddresseProvider = () =>
  Provider.succeed(UsersSettingsForwardingAddresse, {
    stables: ["forwardingEmail", "userId", "project", "verificationStatus"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousEmail = olds?.forwardingEmail ?? output?.forwardingEmail;
      if (
        previousEmail !== undefined &&
        news.forwardingEmail !== previousEmail
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const forwardingEmail =
        olds?.forwardingEmail ?? output?.forwardingEmail ?? "";
      const existing = yield* getForwardingAddress(userId, forwardingEmail);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return output !== undefined || isAlchemyEmail(existing.forwardingEmail)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const addresses = yield* listForwardingAddresses(DEFAULT_USER);
        return addresses
          .filter((address) => isAlchemyEmail(address.forwardingEmail))
          .map((address) => toAttrs(address, DEFAULT_USER, env.project));
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(news.userId, output?.userId);
      const forwardingEmail = news.forwardingEmail;

      let current = yield* getForwardingAddress(userId, forwardingEmail);

      if (current === undefined) {
        const created = yield* gmail
          .createUsersSettingsForwardingAddresses({
            userId,
            body: { forwardingEmail },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getForwardingAddress(userId, forwardingEmail),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersSettingsForwardingAddresseNotResolved({
          userId,
          forwardingEmail,
        });
      }

      if (
        current.forwardingEmail !== undefined &&
        !sameText(current.forwardingEmail, forwardingEmail)
      ) {
        return yield* new UsersSettingsForwardingAddresseNotResolved({
          userId,
          forwardingEmail,
        });
      }

      return toAttrs(current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.forwardingEmail.length === 0) return;
      yield* ignoreMissing(
        gmail.deleteUsersSettingsForwardingAddresses({
          userId: output.userId || DEFAULT_USER,
          forwardingEmail: output.forwardingEmail,
        }),
      );
    }),
  });
