import { Credentials, Services } from "@distilled.cloud/forgejo";
import type { Organization as ApiOrganization } from "@distilled.cloud/forgejo/organization";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { discovered, requireOwnership } from "./Ownership.ts";
import * as Schedule from "effect/Schedule";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { originOf } from "./Credentials.ts";
import { listAccessibleOrganizations } from "./Lists.ts";
import { replaceWhenChanged } from "./Replacement.ts";
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
   * Visibility. Forgejo 16.0.3 ignores edits from non-public to public;
   * reconciliation reports OrganizationSettingsNotApplied rather than false success.
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
 * belong to an administrator. Existing organizations require explicit adoption
 * before their settings converge. Organizations are retained by default.
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

/**
 * Raised when a deployed organization's `owner` is changed.
 *
 * Forgejo creates an organization under a user account but offers no endpoint
 * to hand it to another one; ownership moves by editing the Owners team. The
 * login identifies the organization globally, so a changed `owner` would
 * otherwise resolve to the same organization and converge as though the
 * transfer had happened.
 */
export class UnsupportedOwnerChange extends Data.TaggedError(
  "UnsupportedOwnerChange",
)<{
  /**
   * Login of the organization whose owner was changed.
   */
  readonly username: string;
  /**
   * Owner recorded in state.
   */
  readonly from: string;
  /**
   * Owner the resource now declares.
   */
  readonly to: string;
}> {
  /**
   * Human-readable description of the unsupported transfer, naming the way out.
   */
  override get message(): string {
    return `Organization '${this.username}' is recorded as owned by '${this.from}' and cannot be transferred to '${this.to}': Forgejo has no ownership-transfer API. Change the organization's Owners team membership in Forgejo and restore the original 'owner', or remove and re-create the organization under the new owner.`;
  }
}

/** A successful edit response did not converge the requested settings. */
export class OrganizationSettingsNotApplied extends Data.TaggedError(
  "OrganizationSettingsNotApplied",
)<{
  readonly message: string;
}> {}

/**
 * Origin of the instance the credential points at.
 *
 * Forgejo's organization representation carries no `html_url` — unlike its
 * repository representation — so the link is derived from the instance the
 * credential is pointed at rather than read off the response.
 */
const instanceOrigin = Effect.gen(function* () {
  const resolve = yield* Credentials;
  return originOf(yield* resolve);
});

const settingsOf = (props: OrganizationProps) => ({
  description: props.description,
  full_name: props.fullName,
  visibility: props.visibility,
  website: props.website,
  email: props.email,
  location: props.location,
});

const attributesOf = (
  origin: string,
  organization: ApiOrganization,
): OrganizationAttributes => ({
  organizationId: organization.id,
  username: organization.username,
  htmlUrl: `${origin}/${encodeURIComponent(organization.username)}`,
});

const observe = (props: Pick<OrganizationProps, "username">) =>
  Services.organization
    .getOrg({ org: props.username })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Provider layer implementing organization lifecycle.
 */
export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    stables: ["organizationId", "username", "htmlUrl"],
    // Only the login identifies a different organization. `owner` names the
    // account the create was issued under, and Forgejo exposes no ownership
    // transfer, so replacing on it would tear down and re-adopt the very same
    // organization — see the guard in `reconcile`.
    diff: replaceWhenChanged<OrganizationProps>("username"),
    list: Effect.fn(function* () {
      const origin = yield* instanceOrigin;
      const organizations = yield* listAccessibleOrganizations();
      return organizations.map((organization) =>
        attributesOf(origin, organization),
      );
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const origin = yield* instanceOrigin;
      const observed = yield* observe(olds);
      if (
        observed === undefined ||
        (output !== undefined && observed.id !== output.organizationId)
      )
        return undefined;
      return discovered(attributesOf(origin, observed), output !== undefined);
    }),
    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const origin = yield* instanceOrigin;

      // An organization's login is globally unique, so a changed `owner` still
      // resolves to the same organization. Forgejo has no ownership-transfer
      // endpoint, so there is no way to honor the change: converging silently
      // would report success for something that never happened.
      if (olds !== undefined && olds.owner !== news.owner) {
        return yield* new UnsupportedOwnerChange({
          username: news.username,
          from: olds.owner,
          to: news.owner,
        });
      }

      // Observe: live state decides whether this is a create or a settings
      // sync, so an adopted organization converges the same way as one we
      // provisioned ourselves.
      let observed = yield* observe(news);
      if (observed !== undefined)
        yield* requireOwnership(
          output?.organizationId === observed.id,
          news.username,
        );
      if (observed === undefined) {
        observed = yield* Services.admin
          .adminCreateOrg({
            owner: news.owner,
            username: news.username,
            ...settingsOf(news),
          })
          .pipe(
            // Duplicate organizations share 403/422 with permission failures.
            Effect.catchTag(["UnprocessableEntity", "Forbidden"], (cause) =>
              Effect.gen(function* () {
                const existing = yield* observe(news);
                if (existing === undefined) return yield* Effect.fail(cause);
                yield* requireOwnership(
                  output?.organizationId === existing.id,
                  news.username,
                );
                return existing;
              }),
            ),
          );
      }

      // Sync only when the live organization differs from what was declared.
      const desired = settingsOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* Services.organization.editOrg({
            org: news.username,
            ...desired,
            // Forgejo's non-pointer string fields clear on omission.
            description: news.description ?? observed.description,
            full_name: news.fullName ?? observed.full_name,
            website: news.website ?? observed.website,
            location: news.location ?? observed.location,
          });
      if (!matchesDesired(updated, desired)) {
        return yield* new OrganizationSettingsNotApplied({
          message: `Forgejo did not apply the requested settings for '${news.username}'. Forgejo 16.0.3 cannot change an existing non-public organization to public through its edit API.`,
        });
      }
      return attributesOf(origin, updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      const live = yield* observe({ username: output.username });
      if (live === undefined || live.id !== output.organizationId) return;
      // Forgejo refuses to delete an organization that still owns
      // repositories, and the engine deletes independent resources
      // concurrently — so an organization that loses the race against its own
      // repositories fails the destroy outright, succeeding only on a re-run.
      // Retry until the repositories are gone.
      yield* Services.organization.deleteOrg({ org: live.username }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: (error) => error._tag === "OrganizationOwnsRepositories",
          schedule: Schedule.exponential("200 millis"),
          times: 6,
        }),
      );
    }),
  });
