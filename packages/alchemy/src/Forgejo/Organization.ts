import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { type ForgejoClient, ForgejoCredentials, optional } from "./Client.ts";
import { listAccessibleOrganizations } from "./Lists.ts";
import { matchesDesired } from "./Settings.ts";
import type * as Forgejo from "./Providers.ts";

/**
 * Desired Forgejo organization settings.
 */
export interface OrganizationProps {
  /**
   * User account under which an administrator creates this organization.
   */
  readonly owner: string;
  /**
   * Organization login.
   */
  readonly username: string;
  /**
   * Description.
   */
  readonly description?: string;
  /**
   * Display name.
   */
  readonly fullName?: string;
  /**
   * Visibility.
   */
  readonly visibility?: "public" | "limited" | "private";
  /**
   * Website.
   */
  readonly website?: string;
  /**
   * Contact email.
   */
  readonly email?: string;
  /**
   * Location.
   */
  readonly location?: string;
}

/**
 * Observed Forgejo organization attributes.
 */
export interface OrganizationAttributes {
  /**
   * Organization numeric ID.
   */
  readonly organizationId: number;
  /**
   * Login.
   */
  readonly username: string;
  /**
   * Web URL.
   */
  readonly htmlUrl: string;
}

/**
 * A Forgejo organization resource.
 */
export interface Organization extends Resource<
  "Forgejo.Organization",
  OrganizationProps,
  OrganizationAttributes,
  never,
  Forgejo.Providers
> {}

/**
 * A Forgejo organization.
 *
 * Creating one uses Forgejo's admin endpoint, so the provider credential must
 * belong to an administrator. An organization that already exists is adopted
 * and its settings converge. Organizations are retained by default.
 *
 * ### Creating an Organization
 * **Example:** Basic Organization
 * ```typescript
 * const org = yield* Forgejo.Organization("acme", {
 *   owner: "admin",
 *   username: "acme",
 * });
 * ```
 *
 * **Example:** Organization with Profile Details
 * ```typescript
 * yield* Forgejo.Organization("acme", {
 *   owner: "admin",
 *   username: "acme",
 *   fullName: "Acme Corporation",
 *   description: "Internal services",
 *   website: "https://acme.example",
 *   visibility: "private",
 * });
 * ```
 *
 * ### Deleting an Organization
 * **Example:** Allow Organization Deletion
 * ```typescript
 * import { destroy } from "alchemy/RemovalPolicy";
 *
 * yield* Forgejo.Organization("scratch", {
 *   owner: "admin",
 *   username: "scratch",
 * }).pipe(destroy());
 * ```
 *
 * @resource
 */
export const Organization = Resource<Organization>("Forgejo.Organization", {
  defaultRemovalPolicy: "retain",
});

interface ApiOrganization {
  readonly id: number;
  readonly username: string;
  readonly description?: string;
  readonly full_name?: string;
  readonly visibility?: string;
  readonly website?: string;
  readonly email?: string;
  readonly location?: string;
}

/**
 * Build the organization's web URL.
 *
 * Forgejo's organization representation carries no `html_url` — unlike its
 * repository representation — so the link is derived from the instance the
 * client is pointed at rather than read off the response.
 */
const htmlUrlFor = (client: ForgejoClient, username: string) =>
  `${client.baseUrl.replace(/\/api\/v1$/, "")}/${encodeURIComponent(username)}`;

const path = (props: Pick<OrganizationProps, "username">) =>
  `/orgs/${encodeURIComponent(props.username)}`;

const settingsOf = (props: OrganizationProps) => ({
  description: props.description,
  full_name: props.fullName,
  visibility: props.visibility,
  website: props.website,
  email: props.email,
  location: props.location,
});

const attributesOf = (
  client: ForgejoClient,
  organization: ApiOrganization,
): OrganizationAttributes => ({
  organizationId: organization.id,
  username: organization.username,
  htmlUrl: htmlUrlFor(client, organization.username),
});

const observe = Effect.fn(function* (
  props: Pick<OrganizationProps, "username">,
) {
  const client = yield* ForgejoCredentials;
  return yield* optional(client.request<ApiOrganization>("GET", path(props)));
});

/**
 * Provider layer implementing organization lifecycle.
 */
export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    stables: ["organizationId"],
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          (news.owner !== olds.owner || news.username !== olds.username)
          ? { action: "replace" as const }
          : undefined,
      ),
    list: Effect.fn(function* () {
      const client = yield* ForgejoCredentials;
      const organizations = yield* listAccessibleOrganizations();
      return organizations.map((organization) =>
        attributesOf(client, organization),
      );
    }),
    read: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      const observed = yield* observe(olds);
      return observed === undefined
        ? undefined
        : attributesOf(client, observed);
    }),
    reconcile: Effect.fn(function* ({ news }) {
      const client = yield* ForgejoCredentials;

      // Observe: live state decides whether this is a create or a settings
      // sync, so an adopted organization converges the same way as one we
      // provisioned ourselves.
      const observed = yield* observe(news);

      if (observed === undefined) {
        const created = yield* client
          .request<ApiOrganization>(
            "POST",
            `/admin/users/${encodeURIComponent(news.owner)}/orgs`,
            {
              body: { username: news.username, ...settingsOf(news) },
            },
          )
          .pipe(
            // A concurrent create wins the race; adopt what is there. The
            // admin endpoint declares 403/422 for a duplicate, not 409, so
            // the conflict surfaces under those tags.
            Effect.catchTag(
              ["ForgejoValidationError", "ForgejoForbidden"],
              () => client.request<ApiOrganization>("GET", path(news)),
            ),
          );
        return attributesOf(client, created);
      }

      // Sync only when the live organization differs from what was declared.
      const desired = settingsOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* client.request<ApiOrganization>("PATCH", path(news), {
            body: desired,
          });
      return attributesOf(client, updated);
    }),
    delete: Effect.fn(function* ({ olds }) {
      const client = yield* ForgejoCredentials;
      yield* optional(client.request<void>("DELETE", path(olds)));
    }),
  });
