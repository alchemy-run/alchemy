import * as galaxy from "@distilled.cloud/starburst-galaxy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export interface ServiceAccountPasswordProps {
  /**
   * ID of the service account the password belongs to (a
   * `ServiceAccount`'s `serviceAccountId`). Changing it replaces the password.
   */
  readonly serviceAccount: string;
  /**
   * Description shown in Galaxy. Galaxy cannot edit a password, so
   * changing it replaces the password (and so rotates it).
   */
  readonly description?: string;
}

export interface ServiceAccountPasswordAttributes {
  /** ID of the service account. */
  readonly serviceAccountId: string;
  /** Galaxy's ID of the password. */
  readonly serviceAccountPasswordId: string;
  /** Description shown in Galaxy. */
  readonly description: string | undefined;
  /**
   * The password Trino clients log in with, `GXY$<passwordPrefix><password>`
   * as Galaxy composes it. Returned by Galaxy only when the password is
   * created, and kept in resource state: treat state as sensitive.
   */
  readonly trinoPassword: Redacted.Redacted<string>;
  /** The password's prefix, part of `trinoPassword`. */
  readonly passwordPrefix: Redacted.Redacted<string>;
  /** The password's secret part, part of `trinoPassword`. */
  readonly password: Redacted.Redacted<string>;
  /** Creation time. */
  readonly created: string;
}

export type ServiceAccountPassword = Resource<
  "StarburstGalaxy.ServiceAccountPassword",
  ServiceAccountPasswordProps,
  ServiceAccountPasswordAttributes,
  never,
  Providers
>;

/**
 * A password of a Starburst Galaxy service account, for Trino clients to
 * log in with. Galaxy returns the secret only when the password is created;
 * Alchemy keeps it in resource state as `Redacted`, and `trinoPassword` is
 * the complete credential (`GXY$<prefix><password>`).
 *
 * A password cannot be changed: changing any prop replaces it, which is
 * how to rotate it. An account can hold several passwords, so a new one
 * can be rolled out before the old one is removed. A password found in
 * Galaxy without Alchemy state cannot be adopted, because its secret is
 * unknown: a new one is created instead.
 *
 * @see https://docs.starburst.io/starburst-galaxy/security/service-accounts.html
 *
 * ### Creating a password
 * **Example:** A password for a service account
 * ```typescript
 * const account = yield* StarburstGalaxy.ServiceAccount("Reporter", {});
 * const password = yield* StarburstGalaxy.ServiceAccountPassword("ReporterPassword", {
 *   serviceAccount: account.serviceAccountId,
 *   description: "BI dashboard",
 * });
 * ```
 *
 * ### Rotating a password
 * **Example:** Bump the description to replace the password on the next deploy
 * ```typescript
 * const account = yield* StarburstGalaxy.ServiceAccount("Reporter", {});
 * yield* StarburstGalaxy.ServiceAccountPassword("ReporterPassword", {
 *   serviceAccount: account.serviceAccountId,
 *   description: "BI dashboard (rotated 2026-11)",
 * });
 * ```
 *
 * ### Using the password
 * **Example:** Hand the credential to a Worker as a secret
 * ```typescript
 * const account = yield* StarburstGalaxy.ServiceAccount("Reporter", {});
 * const password = yield* StarburstGalaxy.ServiceAccountPassword("ReporterPassword", {
 *   serviceAccount: account.serviceAccountId,
 * });
 * const secret = yield* Cloudflare.SecretsStore.Secret("TrinoPassword", {
 *   value: password.trinoPassword,
 * });
 * ```
 *
 * @resource
 * @product Access control
 */
export const ServiceAccountPassword = Resource<ServiceAccountPassword>(
  "StarburstGalaxy.ServiceAccountPassword",
);

/** Galaxy created a password but returned no secret for it. */
export class MissingServiceAccountPassword extends Data.TaggedError(
  "StarburstGalaxy.MissingServiceAccountPassword",
)<{
  readonly serviceAccountId: string;
  readonly serviceAccountPasswordId: string;
}> {
  override get message() {
    return `Galaxy returned no secret for the new password ${this.serviceAccountPasswordId} of service account ${this.serviceAccountId}`;
  }
}

const redacted = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? value : Redacted.make(value);

/** The password as Galaxy lists it now; `undefined` when it, or its account, is gone. */
const observe = (serviceAccountId: string, serviceAccountPasswordId: string) =>
  galaxy.serviceAccount.getServiceAccount({ serviceAccountId }).pipe(
    Effect.map((account) =>
      account.passwords.find(
        (password) => password.serviceAccountPasswordId === serviceAccountPasswordId,
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const ServiceAccountPasswordProvider = () =>
  Provider.succeed(ServiceAccountPassword, {
    stables: [
      "serviceAccountId",
      "serviceAccountPasswordId",
      "trinoPassword",
      "passwordPrefix",
      "password",
      "created",
    ],

    nuke: {
      dependsOn: ["StarburstGalaxy.ServiceAccount"],
    },

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // Galaxy has no update for passwords: any change is a new password.
      if (deepEqual(olds, news)) return undefined;
      return { action: "replace" } as const;
    }),

    // The secret is in state only; a password without state cannot be adopted.
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      const password = yield* observe(output.serviceAccountId, output.serviceAccountPasswordId);
      return password === undefined ? undefined : { ...output, description: password.description };
    }),

    reconcile: Effect.fn(function* ({ news, output, session }) {
      // Observe: the stored password, if Galaxy still has it.
      const existing =
        output === undefined
          ? undefined
          : yield* observe(output.serviceAccountId, output.serviceAccountPasswordId);
      if (output !== undefined && existing !== undefined) return output;

      // Ensure: a new password; Galaxy returns its secret this once.
      yield* session.note(`Creating a password for service account ${news.serviceAccount}...`);
      const created = yield* galaxy.serviceAccount.createServiceAccountPassword({
        serviceAccountId: news.serviceAccount,
        description: news.description,
      });
      if (created.password === undefined) {
        return yield* new MissingServiceAccountPassword({
          serviceAccountId: news.serviceAccount,
          serviceAccountPasswordId: created.serviceAccountPasswordId,
        });
      }
      const passwordPrefix = redacted(created.passwordPrefix);
      const password = redacted(created.password);
      return {
        serviceAccountId: news.serviceAccount,
        serviceAccountPasswordId: created.serviceAccountPasswordId,
        description: created.description,
        trinoPassword: Redacted.make(
          `GXY$${Redacted.value(passwordPrefix)}${Redacted.value(password)}`,
        ),
        passwordPrefix,
        password,
        created: created.created,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* galaxy.serviceAccount
        .deleteServiceAccountPassword({
          serviceAccountId: output.serviceAccountId,
          serviceAccountPasswordId: output.serviceAccountPasswordId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),

    // A listed password's secret is no longer returned by Galaxy.
    list: () =>
      galaxy.serviceAccount.listServiceAccounts.items({}).pipe(
        Stream.flatMap((account) =>
          Stream.fromIterable(
            account.passwords.map((password): ServiceAccountPasswordAttributes => ({
              serviceAccountId: account.serviceAccountId,
              serviceAccountPasswordId: password.serviceAccountPasswordId,
              description: password.description,
              trinoPassword: Redacted.make(""),
              passwordPrefix: redacted(password.passwordPrefix),
              password: Redacted.make(""),
              created: password.created,
            })),
          ),
        ),
        Stream.runCollect,
        Effect.map((chunk) => Array.from(chunk)),
      ),
  });
