import type * as gmailpostmastertools from "@distilled.cloud/gcp/gmailpostmastertools_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { DomainsUser } from "./DomainsUser.ts";

export interface GetDomainsUserRequest extends Omit<
  gmailpostmastertools.GetDomainsUsersRequest,
  "name"
> {}

/**
 * Runtime binding for Postmaster Tools `domains.users.get`.
 *
 * Bind this operation to a {@link DomainsUser} in a Function/Action
 * init phase. Provide {@link GetDomainsUserHttp}.
 *
 * ### Reading Users
 * **Example:** Read user metadata
 * ```typescript
 * const getUser = yield* GCP.Gmailpostmastertools.GetDomainsUser(user);
 * const metadata = yield* getUser({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Gmail Postmaster Tools
 */
export interface GetDomainsUser extends Binding.Service<
  GetDomainsUser,
  "GCP.Gmailpostmastertools.GetDomainsUser",
  (
    user: DomainsUser,
  ) => Effect.Effect<
    (
      request: GetDomainsUserRequest,
    ) => Effect.Effect<
      gmailpostmastertools.User,
      gmailpostmastertools.GetDomainsUsersError,
      RuntimeContext
    >
  >
> {}

export const GetDomainsUser = Binding.Service<GetDomainsUser>(
  "GCP.Gmailpostmastertools.GetDomainsUser",
);
