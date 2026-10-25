import * as applications from "@distilled.cloud/microsoft-graph/applications";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { Providers } from "../Providers.ts";
import { orUndefinedIfGone, REPLICATION_LAG } from "./internal.ts";

export interface ApplicationPasswordProps {
  /**
   * Object ID of the application (`app.objectId`), not its client ID.
   * Changing it replaces the password.
   */
  applicationObjectId: string;
  /**
   * Friendly name of the password, shown in the Entra admin center.
   * Changing it replaces (rotates) the password.
   */
  displayName?: string;
  /**
   * When the password stops working, as an ISO 8601 UTC timestamp, e.g.
   * `2027-01-01T00:00:00Z`. Changing it replaces (rotates) the password.
   * @default two years after creation
   */
  endDateTime?: string;
  /**
   * When the password starts working, as an ISO 8601 UTC timestamp.
   * Changing it replaces (rotates) the password.
   * @default the time of creation
   */
  startDateTime?: string;
}

export interface ApplicationPassword extends Resource<
  "Azure.Entra.ApplicationPassword",
  ApplicationPasswordProps,
  {
    /** ID of the password credential on the application. */
    keyId: string;
    /** Object ID of the application that holds the password. */
    applicationObjectId: string;
    /** The client secret. Entra returns it only once, when it is created. */
    secretText: Redacted.Redacted<string>;
    /** First three characters of the secret. */
    hint: string | undefined;
    /** Friendly name. */
    displayName: string | undefined;
    /** When the password starts working (ISO 8601). */
    startDateTime: string | undefined;
    /** When the password stops working (ISO 8601). */
    endDateTime: string | undefined;
  },
  never,
  Providers
> {}

/** Graph did not return the secret of a new password. */
export class ApplicationPasswordSecretMissing extends Data.TaggedError(
  "Azure.Entra.ApplicationPasswordSecretMissing",
)<{
  readonly applicationObjectId: string;
  readonly message: string;
}> {}

/** A removed password was still listed on its application. */
export class ApplicationPasswordDeleteTimedOut extends Data.TaggedError(
  "Azure.Entra.ApplicationPasswordDeleteTimedOut",
)<{
  readonly keyId: string;
  readonly message: string;
}> {}

/**
 * A client secret (password credential) on a Microsoft Entra ID
 * application. Programs sign in with the application's client ID and this
 * secret.
 *
 * Entra returns the secret only when it is created, so Alchemy keeps it in
 * state as a `Redacted` value. Every prop replaces the password: change
 * `endDateTime` (or `displayName`) to rotate it. The new password is
 * created before the old one is removed, so consumers that read
 * `secretText` from the stack switch over without a gap.
 *
 * Passwords have no tags. They belong to their application and are
 * removed with it.
 *
 * @see https://learn.microsoft.com/graph/api/application-addpassword
 *
 * ### Creating a Client Secret
 * **Example:** A secret that expires at the end of 2027
 * ```typescript
 * const app = yield* Azure.Entra.Application("Ci");
 * const secret = yield* Azure.Entra.ApplicationPassword("CiSecret", {
 *   applicationObjectId: app.objectId,
 *   displayName: "ci",
 *   endDateTime: "2027-12-31T00:00:00Z",
 * });
 * // secret.secretText is a Redacted<string>
 * ```
 *
 * ### Rotating a Secret
 * **Example:** Rotate by moving the expiry
 * ```typescript
 * // Changing endDateTime creates a new password, then removes the old one.
 * const secret = yield* Azure.Entra.ApplicationPassword("CiSecret", {
 *   applicationObjectId: app.objectId,
 *   endDateTime: "2028-06-30T00:00:00Z",
 * });
 * ```
 *
 * @resource
 */
export const ApplicationPassword = Resource<ApplicationPassword>("Azure.Entra.ApplicationPassword");

/** The password credential `keyId` on the application, if both still exist. */
const findPassword = (applicationObjectId: string, keyId: string) =>
  orUndefinedIfGone(
    applications.getApplication({
      applicationId: applicationObjectId,
      select: ["id", "passwordCredentials"],
    }),
  ).pipe(
    Effect.map((app) =>
      (app?.passwordCredentials ?? []).find((credential) => credential.keyId === keyId),
    ),
  );

/**
 * {@link findPassword} for a password Alchemy recorded: a new password (or
 * application) is missing from some replicas for a few seconds, so poll
 * for up to ~30 s before reporting it gone.
 */
const awaitPassword = (applicationObjectId: string, keyId: string) =>
  findPassword(applicationObjectId, keyId).pipe(
    Effect.repeat({
      until: (found) => found !== undefined,
      schedule: Schedule.spaced("3 seconds"),
      times: 10,
    }),
  );

const sameProps = (a: Partial<ApplicationPasswordProps> | undefined, b: ApplicationPasswordProps) =>
  a?.applicationObjectId === b.applicationObjectId &&
  a?.displayName === b.displayName &&
  a?.endDateTime === b.endDateTime &&
  a?.startDateTime === b.startDateTime;

export const ApplicationPasswordProvider = () =>
  Provider.succeed(ApplicationPassword, {
    stables: ["keyId", "applicationObjectId", "secretText"],

    // Passwords are listed through their application, which `list` of
    // `Azure.Entra.Application` already covers; deleting it removes them.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news)) return { action: "replace" } as const;
      return sameProps(olds, news) ? undefined : ({ action: "replace" } as const);
    }),

    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const found = yield* awaitPassword(output.applicationObjectId, output.keyId);
      return found === undefined ? undefined : output;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      // Existence only: every prop replaces, and the secret cannot be read
      // back, so an existing password is kept as recorded.
      if (output !== undefined && output.applicationObjectId === news.applicationObjectId) {
        const found = yield* awaitPassword(output.applicationObjectId, output.keyId);
        if (found !== undefined) return output;
      }

      // A brand-new application is not readable on every replica yet.
      const created = yield* applications
        .addPassword({
          applicationId: news.applicationObjectId,
          passwordCredential: {
            displayName: news.displayName ?? null,
            endDateTime: news.endDateTime ?? null,
            startDateTime: news.startDateTime ?? null,
          },
        })
        .pipe(Effect.retry(REPLICATION_LAG));
      const secret = created.secretText;
      if (secret === undefined || secret === null || created.keyId == null) {
        return yield* new ApplicationPasswordSecretMissing({
          applicationObjectId: news.applicationObjectId,
          message: `addPassword on application ${news.applicationObjectId} returned no secretText or keyId`,
        });
      }
      // Wait until reads see the new key, so a later read or delete finds it.
      yield* awaitPassword(news.applicationObjectId, created.keyId);
      return {
        keyId: created.keyId,
        applicationObjectId: news.applicationObjectId,
        secretText: Redacted.isRedacted(secret) ? secret : Redacted.make(secret),
        hint: created.hint ?? undefined,
        displayName: created.displayName ?? undefined,
        startDateTime: created.startDateTime ?? undefined,
        endDateTime: created.endDateTime ?? undefined,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      // Right after `addPassword` Graph can still answer
      // `PasswordCredentialNotFound`; remove until the key is gone.
      const removeOnce = Effect.gen(function* () {
        const found = yield* findPassword(output.applicationObjectId, output.keyId);
        if (found === undefined) return "gone" as const;
        yield* applications
          .removePassword({ applicationId: output.applicationObjectId, keyId: output.keyId })
          .pipe(
            Effect.catchTag(["PasswordCredentialNotFound", "ResourceNotFound"], () => Effect.void),
          );
        return "pending" as const;
      });
      const last = yield* removeOnce.pipe(
        Effect.repeat({
          until: (state) => state === "gone",
          schedule: Schedule.spaced("3 seconds"),
          times: 10,
        }),
      );
      if (last !== "gone") {
        return yield* new ApplicationPasswordDeleteTimedOut({
          keyId: output.keyId,
          message: `password ${output.keyId} is still on application ${output.applicationObjectId}`,
        });
      }
    }),
  });
