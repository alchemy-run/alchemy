import { Credentials, Services } from "@distilled.cloud/forgejo";
import type { Organization as ApiOrganization } from "@distilled.cloud/forgejo/organization";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { originOf } from "./Credentials.ts";
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
    .orgGet({ org: props.username })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

/**
 * Provider layer implementing organization lifecycle.
 */
export const OrganizationProvider = () =>
  Provider.succeed(Organization, {
    stables: ["organizationId"],
    // Only the login identifies a different organization. `owner` names the
    // account the create was issued under, and Forgejo exposes no ownership
    // transfer, so replacing on it would tear down and re-adopt the very same
    // organization — see the guard in `reconcile`.
    diff: ({ news, olds }) =>
      Effect.succeed(
        isResolved(news) &&
          olds !== undefined &&
          news.username !== olds.username
          ? { action: "replace" as const }
          : undefined,
      ),
    list: Effect.fn(function* () {
      const origin = yield* instanceOrigin;
      const organizations = yield* listAccessibleOrganizations();
      return organizations.map((organization) =>
        attributesOf(origin, organization),
      );
    }),
    read: Effect.fn(function* ({ olds }) {
      const origin = yield* instanceOrigin;
      const observed = yield* observe(olds);
      return observed === undefined
        ? undefined
        : attributesOf(origin, observed);
    }),
    reconcile: Effect.fn(function* ({ news, olds }) {
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
      const observed = yield* observe(news);

      if (observed === undefined) {
        const created = yield* Services.admin
          .adminCreateOrg({
            owner: news.owner,
            username: news.username,
            ...settingsOf(news),
          })
          .pipe(
            // A concurrent create wins the race; adopt what is there. The
            // admin endpoint declares 403/422 for a duplicate, not 409, so
            // the conflict surfaces under those tags.
            //
            // Those tags also cover genuine failures — a non-administrator
            // credential gets the same 403 — so recover only if the
            // organization actually turned up. Otherwise re-fail with the
            // original error: reporting "not found" for what is really "your
            // token is not an administrator" replaces the clearest diagnosis
            // with the most misleading one.
            Effect.catchTag(["UnprocessableEntity", "Forbidden"], (cause) =>
              observe(news).pipe(
                Effect.flatMap((existing) =>
                  existing === undefined
                    ? Effect.fail(cause)
                    : Effect.succeed(existing),
                ),
              ),
            ),
          );
        return attributesOf(origin, created);
      }

      // Sync only when the live organization differs from what was declared.
      const desired = settingsOf(news);
      const updated = matchesDesired(observed, desired)
        ? observed
        : yield* Services.organization.orgEdit({
            org: news.username,
            ...desired,
          });
      return attributesOf(origin, updated);
    }),
    delete: Effect.fn(function* ({ olds }) {
      // Forgejo refuses to delete an organization that still owns
      // repositories, and the engine deletes independent resources
      // concurrently — so an organization that loses the race against its own
      // repositories fails the destroy outright, succeeding only on a re-run.
      // Retry until the repositories are gone.
      yield* Services.organization.orgDelete({ org: olds.username }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.retry({
          while: (error) => error._tag === "OrganizationOwnsRepositories",
          schedule: Schedule.exponential("200 millis"),
          times: 6,
        }),
      );
    }),
  });
