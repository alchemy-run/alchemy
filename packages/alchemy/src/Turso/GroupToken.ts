import * as turso from "@distilled.cloud/turso/turso";
import * as Effect from "effect/Effect";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { organization } from "./Credentials.ts";
import {
  isTokenCurrent,
  tokenExpiry,
  type SqlTokenAttributes,
  type SqlTokenProps,
} from "./DatabaseToken.ts";
import type { Providers } from "./Providers.ts";

export interface GroupTokenProps extends SqlTokenProps {
  /** Name of the group whose databases the token grants access to. */
  group: string;
}

export interface GroupTokenAttributes extends SqlTokenAttributes {
  /** Name of the group the token grants access to. */
  group: string;
  /** UUID of the group the token was minted for. */
  groupId: string;
}

export type GroupToken = Resource<
  "Turso.GroupToken",
  GroupTokenProps,
  GroupTokenAttributes,
  never,
  Providers
>;

/**
 * A SQL auth token valid for every database in a Turso {@link Group} —
 * including databases created after the token. The natural fit for
 * database-per-tenant apps, where one token must reach many databases.
 *
 * Like {@link DatabaseToken}, group tokens are stateless JWTs that cannot be
 * revoked one at a time: a prop change mints a new token while the old one
 * stays valid until it expires, and destroying the resource does not
 * revoke it.
 * @see https://docs.turso.tech/api-reference/groups/create-token
 *
 * ### Minting a Token
 * **Example:** Full-access token for every database in a group
 * ```typescript
 * const token = yield* Turso.GroupToken("Token", {
 *   group: group.name,
 * });
 * ```
 *
 * **Example:** Read-only token that expires after a week
 * ```typescript
 * const token = yield* Turso.GroupToken("ReadOnly", {
 *   group: group.name,
 *   authorization: "read-only",
 *   expiration: "7d",
 * });
 * ```
 *
 * @resource
 * @product Group
 */
export const GroupToken = Resource<GroupToken>("Turso.GroupToken");

export const GroupTokenProvider = () =>
  Provider.effect(
    GroupToken,
    Effect.gen(function* () {
      return {
        stables: ["organization"],
        reconcile: Effect.fn(function* ({ news, olds, output }) {
          const org = output?.organization ?? (yield* organization);

          // Observe — the token is bound to the group's UUID, so a group
          // replaced under the same name invalidates it.
          const { group } = yield* turso.getGroup({
            organizationSlug: org,
            groupName: news.group,
          });
          const groupId = group?.uuid ?? "";
          if (
            output !== undefined &&
            output.group === news.group &&
            output.groupId === groupId &&
            (yield* isTokenCurrent(output, olds, news))
          ) {
            return output;
          }

          // Ensure — mint.
          const authorization = news.authorization ?? "full-access";
          const { jwt } = yield* turso.createGroupToken({
            organizationSlug: org,
            groupName: news.group,
            authorization,
            expiration: news.expiration,
            permissions: news.readAttach
              ? { read_attach: { databases: news.readAttach } }
              : undefined,
          });
          if (!jwt) {
            return yield* Effect.fail(new Error(`Turso returned no token for group ${news.group}`));
          }
          return {
            token: jwt,
            organization: org,
            authorization,
            expiresAt: tokenExpiry(jwt),
            group: news.group,
            groupId,
          };
        }),
        // Turso cannot revoke a single token; it simply stops being tracked.
        delete: () => Effect.void,
      };
    }),
  );
