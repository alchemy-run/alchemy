import * as Entire from "@distilled.cloud/entire";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeClient } from "./internal/Client.ts";
import type { Providers } from "./Providers.ts";

export type ServiceAccountGrantProps = {
  /** The service account's `accountId`. Changing it replaces the grant. */
  accountId: string;
  /** Kind of resource the grant is on. Changing it replaces the grant. */
  resourceType: "project" | "repo";
  /** ID of the project or repository. Changing it replaces the grant. */
  resourceId: string;
  /** Access level. */
  role: "reader" | "writer" | "admin";
};

export type ServiceAccountGrant = Resource<
  "Entire.ServiceAccountGrant",
  ServiceAccountGrantProps,
  {
    accountId: string;
    resourceType: "project" | "repo";
    resourceId: string;
    role: string;
  },
  never,
  Providers
>;

/**
 * Gives a {@link ServiceAccount} a role on one project or repository. A
 * service account holds one role per resource, so changing `role` updates
 * the grant in place.
 *
 * ### Granting Access
 * **Example:** Let CI push to a repository
 * ```typescript
 * yield* Entire.ServiceAccountGrant("ci-writes-api", {
 *   accountId: ci.accountId,
 *   resourceType: "repo",
 *   resourceId: repo.id,
 *   role: "writer",
 * });
 * ```
 *
 * **Example:** Read access to a whole project
 * ```typescript
 * yield* Entire.ServiceAccountGrant("ci-reads-app", {
 *   accountId: ci.accountId,
 *   resourceType: "project",
 *   resourceId: project.id,
 *   role: "reader",
 * });
 * ```
 *
 * @resource
 * @product ServiceAccount
 */
export const ServiceAccountGrant = Resource<ServiceAccountGrant>("Entire.ServiceAccountGrant");

export const ServiceAccountGrantProvider = () =>
  Provider.effect(
    ServiceAccountGrant,
    Effect.gen(function* () {
      const client = yield* makeClient;

      const observe = (props: Omit<ServiceAccountGrantProps, "role">) =>
        client.core(
          Entire.serviceAccounts.listServiceAccountGrants
            .items({ accountId: props.accountId })
            .pipe(
              Stream.filter(
                (g) => g.resourceType === props.resourceType && g.resourceId === props.resourceId,
              ),
              Stream.runHead,
              Effect.map(Option.getOrUndefined),
            ),
        );

      return {
        stables: ["accountId", "resourceType", "resourceId"],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || !output) return undefined;
          if (
            news.accountId !== output.accountId ||
            news.resourceType !== output.resourceType ||
            news.resourceId !== output.resourceId
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const key = output ?? olds;
          if (!key) return undefined;
          const grant = yield* observe(key).pipe(
            Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          );
          return grant
            ? {
                accountId: key.accountId,
                resourceType: key.resourceType,
                resourceId: key.resourceId,
                role: grant.role,
              }
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ news }) {
          const observed = yield* observe(news);
          // Granting again with another role replaces the role.
          if (observed?.role !== news.role) {
            yield* client.core(
              Entire.serviceAccounts.grantServiceAccountAccess({
                accountId: news.accountId,
                resourceType: news.resourceType,
                resourceId: news.resourceId,
                role: news.role,
              }),
            );
          }
          return {
            accountId: news.accountId,
            resourceType: news.resourceType,
            resourceId: news.resourceId,
            role: news.role,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* client
            .core(
              Entire.serviceAccounts.revokeServiceAccountAccess({
                accountId: output.accountId,
                resourceType: output.resourceType,
                resourceId: output.resourceId,
              }),
            )
            .pipe(Effect.catchTag("NotFound", () => Effect.void));
        }),
      };
    }),
  );
