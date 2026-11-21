import * as discord from "@distilled.cloud/discord/discord";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { applicationId, sameJson } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

/** One value a Linked Role can require. */
export interface RoleConnectionMetadataRecord {
  /** Key the app writes per user, 1-50 characters of `a-z`, `0-9` or `_`. */
  key: string;
  /** Name shown to server admins, 1-100 characters. */
  name: string;
  /** Description shown to server admins, 1-200 characters. */
  description: string;
  /**
   * How a guild's requirement compares to the user's value:
   * `integerLessThanOrEqual`, `integerGreaterThanOrEqual`, `integerEqual`,
   * `integerNotEqual`, `datetimeLessThanOrEqual` (days ago),
   * `datetimeGreaterThanOrEqual`, `booleanEqual` or `booleanNotEqual`.
   */
  type:
    | "integerLessThanOrEqual"
    | "integerGreaterThanOrEqual"
    | "integerEqual"
    | "integerNotEqual"
    | "datetimeLessThanOrEqual"
    | "datetimeGreaterThanOrEqual"
    | "booleanEqual"
    | "booleanNotEqual";
  /** Localized names, keyed by locale. */
  nameLocalizations?: Record<string, string>;
  /** Localized descriptions, keyed by locale. */
  descriptionLocalizations?: Record<string, string>;
}

export interface RoleConnectionMetadataProps {
  /** Up to 5 records. The app's whole metadata list is replaced with them. */
  records: RoleConnectionMetadataRecord[];
}

export interface RoleConnectionMetadataAttributes {
  /** Application id. */
  applicationId: string;
  /** Registered keys. */
  keys: string[];
}

/**
 * The Linked Roles metadata of the application: the values (account age,
 * level, verified, ...) server admins can require for a role, which the app
 * writes per user through OAuth2.
 *
 * There is one list per application; deploys replace it whole and destroy
 * clears it. Set `Application.roleConnectionsVerificationUrl` to the page
 * where users connect their account.
 *
 * ### Declaring Linked Roles Metadata
 * **Example:** Level and verified
 * ```typescript
 * yield* Discord.RoleConnectionMetadata("LinkedRoles", {
 *   records: [
 *     { key: "level", name: "Level", description: "Minimum level", type: "integerGreaterThanOrEqual" },
 *     { key: "verified", name: "Verified", description: "Has a verified account", type: "booleanEqual" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @product Application
 */
export interface RoleConnectionMetadata extends Resource<
  "Discord.RoleConnectionMetadata",
  RoleConnectionMetadataProps,
  RoleConnectionMetadataAttributes,
  never,
  Providers
> {}

export const RoleConnectionMetadata = Resource<RoleConnectionMetadata>(
  "Discord.RoleConnectionMetadata",
);

const TYPES: Record<RoleConnectionMetadataRecord["type"], number> = {
  integerLessThanOrEqual: 1,
  integerGreaterThanOrEqual: 2,
  integerEqual: 3,
  integerNotEqual: 4,
  datetimeLessThanOrEqual: 5,
  datetimeGreaterThanOrEqual: 6,
  booleanEqual: 7,
  booleanNotEqual: 8,
};

const body = (records: RoleConnectionMetadataRecord[]) =>
  records.map((r) => ({
    type: TYPES[r.type],
    key: r.key,
    name: r.name,
    description: r.description,
    name_localizations: r.nameLocalizations ?? null,
    description_localizations: r.descriptionLocalizations ?? null,
  }));

const observedBody = (
  records: ReadonlyArray<discord.ApplicationRoleConnectionsMetadataItemResponse>,
) =>
  records.map((r) => ({
    type: Number(r.type),
    key: r.key,
    name: r.name,
    description: r.description,
    name_localizations: r.name_localizations ?? null,
    description_localizations: r.description_localizations ?? null,
  }));

export const RoleConnectionMetadataProvider = () =>
  Provider.succeed(RoleConnectionMetadata, {
    nuke: { singleton: true },
    stables: ["applicationId"],

    read: Effect.fn(function* () {
      const appId = yield* applicationId();
      const records =
        (yield* discord.getApplicationRoleConnectionsMetadata({ application_id: appId })) ?? [];
      return records.length === 0
        ? undefined
        : { applicationId: appId, keys: records.map((r) => r.key) };
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const appId = yield* applicationId();
      const observed =
        (yield* discord.getApplicationRoleConnectionsMetadata({ application_id: appId })) ?? [];
      const want = body(news.records);
      if (!sameJson(observedBody(observed), want)) {
        yield* discord.updateApplicationRoleConnectionsMetadata({
          application_id: appId,
          body: want,
        });
      }
      return { applicationId: appId, keys: news.records.map((r) => r.key) };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discord.updateApplicationRoleConnectionsMetadata({
        application_id: output.applicationId,
        body: [],
      });
    }),

    list: () => Effect.succeed([]),
  });
