import * as organizations from "@distilled.cloud/daytona/organizations";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { resolveName } from "./internal/Names.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationProps {
  /** Organization name. If omitted, generated from the stack, stage and logical ID. */
  name?: string;
  /**
   * Region new sandboxes go to by default. Daytona sets it once, so changing
   * it replaces the organization.
   */
  defaultRegionId: string;
}

export interface OrganizationAttributes {
  /** Organization ID. */
  organizationId: string;
  /** Name. */
  name: string;
  /** Default region. */
  defaultRegionId: string | undefined;
}

export type Organization = Resource<
  "Daytona.Organization",
  OrganizationProps,
  OrganizationAttributes,
  never,
  Providers
>;

/**
 * A new Daytona organization, owned by the signed-in user. Creating
 * organizations needs a user login, not an organization API key: an API
 * key already belongs to exactly one organization. To configure the
 * organization your key belongs to, use {@link OrganizationSettings}.
 *
 * ### Creating an Organization
 * **Example:** A separate organization for a team
 * ```typescript
 * export const Team = Daytona.Organization("Team", { defaultRegionId: "us" });
 * ```
 *
 * @resource
 * @product Organization
 */
export const Organization = Resource<Organization>("Daytona.Organization");

const toAttributes = (o: organizations.Organization): OrganizationAttributes => ({
  organizationId: o.id,
  name: o.name,
  defaultRegionId: o.defaultRegionId,
});

export const OrganizationProvider = () =>
  Provider.effect(
    Organization,
    Effect.succeed({
      stables: ["organizationId"],
      nuke: { skip: true },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ id, news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        const name = yield* resolveName(
          id,
          news.name,
          news.name === undefined ? output.name : undefined,
        );
        // Reconcile finds an organization by name, so the old one must go
        // first or the replacement would adopt it.
        if (
          name !== output.name ||
          (output.defaultRegionId !== undefined && news.defaultRegionId !== output.defaultRegionId)
        ) {
          return { action: "replace", deleteFirst: true } as const;
        }
      }),
      read: Effect.fn(function* ({ output }) {
        if (output === undefined) return undefined;
        return yield* organizations.getOrganization({ organizationId: output.organizationId }).pipe(
          Effect.map(toAttributes),
          Effect.catchTag("OrganizationNotFound", () => Effect.undefined),
        );
      }),
      reconcile: Effect.fn(function* ({ id, news, output }) {
        const name = yield* resolveName(id, news.name, output?.name);
        // Observe
        let current = output
          ? yield* organizations
              .getOrganization({ organizationId: output.organizationId })
              .pipe(Effect.catchTag("OrganizationNotFound", () => Effect.undefined))
          : (yield* organizations.listOrganizations({})).find((o) => o.name === name);
        // Ensure
        if (current === undefined) {
          current = yield* organizations.createOrganization({
            name,
            defaultRegionId: news.defaultRegionId,
          });
        }
        // Sync: Daytona only accepts a default region while none is set
        // (an adopted organization); changing one replaces (see diff).
        if (current.defaultRegionId === undefined) {
          yield* organizations.setOrganizationDefaultRegion({
            organizationId: current.id,
            defaultRegionId: news.defaultRegionId,
          });
          current = yield* organizations.getOrganization({ organizationId: current.id });
        }
        return toAttributes(current);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* organizations
          .deleteOrganization({ organizationId: output.organizationId })
          .pipe(Effect.catchTag("OrganizationNotFound", () => Effect.void));
      }),
    }),
  );
