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
  getDelegate,
  ignoreMissing,
  isAlchemyEmail,
  listDelegates,
  sameText,
  toUserId,
} from "./internal.ts";

export type UsersSettingsDelegateProps = {
  /**
   * Mailbox to manage. Email address or `"me"`.
   * @default "me"
   */
  userId?: string;
  /**
   * Primary email of the delegate. Identity — changing it replaces the
   * delegate. Must be a Workspace user in the same organization.
   */
  delegateEmail: string;
};

export type UsersSettingsDelegate = Resource<
  "GCP.Gmail.UsersSettingsDelegate",
  UsersSettingsDelegateProps,
  {
    /** Delegate email. */
    delegateEmail: string;
    /** Mailbox the delegate belongs to. */
    userId: string;
    /** Project id used when the delegate was reconciled. */
    project: string;
    /** Verification status. */
    verificationStatus: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Gmail mailbox delegate.
 *
 * Delegates have no labels or description, so identity is
 * `(userId, delegateEmail)` and `list` / nuke returns rows whose email
 * local-part starts with `alchemy-`. There is nothing mutable beyond
 * identity — changing mailbox or email replaces the delegate. Create
 * requires domain-wide delegation and a Workspace peer.
 *
 * ### Creating a Delegate
 * **Example:** Add a delegate
 * ```typescript
 * const delegate = yield* GCP.Gmail.UsersSettingsDelegate("Ada", {
 *   delegateEmail: "ada@example.com",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Gmail
 */
export const UsersSettingsDelegate = Resource<UsersSettingsDelegate>(
  "GCP.Gmail.UsersSettingsDelegate",
);

export class UsersSettingsDelegateNotResolved extends Data.TaggedError(
  "GCP.Gmail.UsersSettingsDelegateNotResolved",
)<{
  userId: string;
  delegateEmail: string;
}> {}

const toAttrs = (
  delegate: gmail.Delegate,
  userId: string,
  project: string,
) => ({
  delegateEmail: delegate.delegateEmail ?? "",
  userId,
  project,
  verificationStatus: delegate.verificationStatus,
});

export const UsersSettingsDelegateProvider = () =>
  Provider.succeed(UsersSettingsDelegate, {
    stables: ["delegateEmail", "userId", "project", "verificationStatus"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousUser = olds?.userId ?? output?.userId ?? DEFAULT_USER;
      const nextUser = news.userId ?? DEFAULT_USER;
      if (nextUser !== previousUser) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousEmail = olds?.delegateEmail ?? output?.delegateEmail;
      if (previousEmail !== undefined && news.delegateEmail !== previousEmail) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(olds?.userId, output?.userId);
      const delegateEmail = olds?.delegateEmail ?? output?.delegateEmail ?? "";
      const existing = yield* getDelegate(userId, delegateEmail);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, userId, env.project);
      return output !== undefined || isAlchemyEmail(existing.delegateEmail)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const delegates = yield* listDelegates(DEFAULT_USER);
        return delegates
          .filter((delegate) => isAlchemyEmail(delegate.delegateEmail))
          .map((delegate) => toAttrs(delegate, DEFAULT_USER, env.project));
      }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const userId = toUserId(news.userId, output?.userId);
      const delegateEmail = news.delegateEmail;

      let current = yield* getDelegate(userId, delegateEmail);

      if (current === undefined) {
        const created = yield* gmail
          .createUsersSettingsDelegates({
            userId,
            body: { delegateEmail },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              getDelegate(userId, delegateEmail),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new UsersSettingsDelegateNotResolved({
          userId,
          delegateEmail,
        });
      }

      if (
        current.delegateEmail !== undefined &&
        !sameText(current.delegateEmail, delegateEmail)
      ) {
        return yield* new UsersSettingsDelegateNotResolved({
          userId,
          delegateEmail,
        });
      }

      return toAttrs(current, userId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.delegateEmail.length === 0) return;
      yield* ignoreMissing(
        gmail.deleteUsersSettingsDelegates({
          userId: output.userId || DEFAULT_USER,
          delegateEmail: output.delegateEmail,
        }),
      );
    }),
  });
