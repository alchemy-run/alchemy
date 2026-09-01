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
  /**
   * Web URL.
   */
  readonly html_url: string;
}

/**
 * List every repository accessible to the provider credential, walking all
 * pages.
 */
export const listAccessibleRepositories = Effect.fn(function* () {
  const client = yield* ForgejoCredentials;
  return yield* paginate<ListedRepository>(client, "/user/repos");
});

/**
 * List every organization visible to the provider credential, walking all
 * pages.
 */
export const listAccessibleOrganizations = Effect.fn(function* () {
  const client = yield* ForgejoCredentials;
  return yield* paginate<ListedOrganization>(client, "/user/orgs");
});
