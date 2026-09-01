import * as Effect from "effect/Effect";
import { ForgejoCredentials, paginate } from "./Client.ts";

/**
 * Minimal repository identity returned by Forgejo list endpoints.
 */
export interface ListedRepository {
  /**
   * Repository owner login.
   */
  readonly owner: { readonly login: string };
  /**
   * Repository name.
   */
  readonly name: string;
}

/**
 * Minimal organization identity returned by Forgejo list endpoints.
 */
export interface ListedOrganization {
  /**
   * Organization login.
   */
  readonly username: string;
  /**
   * Numeric organization ID.
   */
  readonly id: number;
}

/**
 * List every repository accessible to the provider credential, walking all
 * pages.
 *
 * Despite the endpoint's "repos that the authenticated user owns" summary,
 * Forgejo 16.0.3 returns organization-owned repositories here too, as long as
 * the credential is a member of the organization — verified against a live
 * instance. The bound is membership, not ownership; see
 * {@link listAccessibleOrganizations} for what that leaves out.
 */
export const listAccessibleRepositories = Effect.fn(function* () {
  const client = yield* ForgejoCredentials;
  return yield* paginate<ListedRepository>(client, "/user/repos");
});

/**
 * List every organization visible to the provider credential, walking all
 * pages.
 *
 * Scoped deliberately to the credential's own memberships. {@link Organization}
 * takes an `owner` distinct from the credential, so an administrator can
 * create an organization it is not a member of, and that organization — plus
 * its repositories, labels, hooks, and Actions state — is invisible here.
 *
 * `/admin/orgs` would close that gap and is not used, because these lists are
 * what `alchemy unsafe nuke` deletes: enumerating every organization on the
 * instance would put every unrelated user's organizations in a nuke's path.
 * Forgejo has no resource tags, so there is no way to narrow such a list back
 * down to what Alchemy created. Under-reporting a resource is recoverable;
 * deleting a stranger's organization is not.
 */
export const listAccessibleOrganizations = Effect.fn(function* () {
  const client = yield* ForgejoCredentials;
  return yield* paginate<ListedOrganization>(client, "/user/orgs");
});
