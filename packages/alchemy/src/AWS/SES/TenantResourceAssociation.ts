import * as sesv2 from "@distilled.cloud/aws/sesv2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";

export interface TenantResourceAssociationProps {
  /**
   * Name of the tenant to associate the resource with. Typically the
   * `tenantName` output of a `SES.Tenant`. Changing it replaces the
   * association.
   */
  tenantName: string;
  /**
   * ARN of the resource to associate — an email identity, configuration set,
   * or email template. Changing it replaces the association.
   */
  resourceArn: string;
}

export interface TenantResourceAssociation extends Resource<
  "AWS.SES.TenantResourceAssociation",
  TenantResourceAssociationProps,
  {
    /** Name of the tenant. */
    tenantName: string;
    /** ARN of the associated resource. */
    resourceArn: string;
  },
  never,
  Providers
> {}

/**
 * An association between an Amazon SES v2 tenant and a resource — an email
 * identity, configuration set, or email template. Once associated, the
 * resource can be used when sending email on behalf of the tenant. A single
 * resource can be associated with multiple tenants.
 *
 * This is an existence-only link with no mutable properties: changing either
 * the tenant or the resource replaces the association.
 * @resource
 * @section Associating Resources
 * @example Associate an Email Identity with a Tenant
 * ```typescript
 * import * as SES from "alchemy/AWS/SES";
 *
 * const tenant = yield* SES.Tenant("CustomerA", {});
 * const identity = yield* SES.EmailIdentity("Sender", {
 *   emailIdentity: "sender@example.com",
 * });
 * const association = yield* SES.TenantResourceAssociation("SenderLink", {
 *   tenantName: tenant.tenantName,
 *   resourceArn: identity.emailIdentityArn,
 * });
 * ```
 */
export const TenantResourceAssociation = Resource<TenantResourceAssociation>(
  "AWS.SES.TenantResourceAssociation",
);

export const TenantResourceAssociationProvider = () =>
  Provider.effect(
    TenantResourceAssociation,
    Effect.gen(function* () {
      const isAssociated = Effect.fn(function* (
        tenantName: string,
        resourceArn: string,
      ) {
        const pages = yield* sesv2.listTenantResources
          .pages({ TenantName: tenantName })
          .pipe(
            Stream.runCollect,
            // A missing tenant means the association cannot exist.
            Effect.catchTag("NotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        if (pages === undefined) return false;
        return Array.from(pages)
          .flatMap((page) => page.TenantResources ?? [])
          .some((resource) => resource.ResourceArn === resourceArn);
      });

      return TenantResourceAssociation.Provider.of({
        stables: ["tenantName", "resourceArn"],

        // Associations are keyed by their parent tenant; there is no flat
        // account-level enumeration, and deleting the tenant removes its
        // associations, so nuke handles them via the parent tenant.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ olds, output }) {
          const tenantName = output?.tenantName ?? olds?.tenantName;
          const resourceArn = output?.resourceArn ?? olds?.resourceArn;
          if (tenantName === undefined || resourceArn === undefined) {
            return undefined;
          }
          const found = yield* isAssociated(tenantName, resourceArn);
          return found ? { tenantName, resourceArn } : undefined;
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (
            news.tenantName !== olds.tenantName ||
            news.resourceArn !== olds.resourceArn
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news, output }) {
          const tenantName = output?.tenantName ?? news.tenantName;
          const resourceArn = output?.resourceArn ?? news.resourceArn;

          // OBSERVE — associations have no update API, so reconcile is
          // create-only.
          const found = yield* isAssociated(tenantName, resourceArn);

          // ENSURE — create if missing; AlreadyExists is a race, not a failure.
          if (!found) {
            yield* sesv2
              .createTenantResourceAssociation({
                TenantName: tenantName,
                ResourceArn: resourceArn,
              })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () =>
                  Effect.succeed({}),
                ),
              );
          }

          return { tenantName, resourceArn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // deleteTenantResourceAssociation is idempotent; a missing tenant or
          // association means the link is already gone.
          yield* sesv2
            .deleteTenantResourceAssociation({
              TenantName: output.tenantName,
              ResourceArn: output.resourceArn,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void));
        }),
      });
    }),
  );
