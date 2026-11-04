import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";
import type { Repository } from "./Repository.ts";

export interface AccessReadTokenRequest extends Omit<
  cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesRequest,
  "repository"
> {}

/**
 * Runtime binding for Cloud Build v2 `repositories.accessReadToken`.
 *
 * Bind this operation to a {@link Repository} in a Function/Action init
 * phase. Provide {@link AccessReadTokenHttp}. Returns a short-lived token
 * that can clone the remote Git repository.
 *
 * ### Fetching a Read Token
 * **Example:** Clone with a read token
 * ```typescript
 * const accessReadToken = yield* GCP.CloudBuild.AccessReadToken(source);
 * const { token, expirationTime } = yield* accessReadToken();
 * ```
 *
 * @binding
 * @category CloudBuild
 */
export interface AccessReadToken extends Binding.Service<
  AccessReadToken,
  "GCP.CloudBuild.AccessReadToken",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: AccessReadTokenRequest,
    ) => Effect.Effect<
      cloudbuild.FetchReadTokenResponse,
      cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesError,
      RuntimeContext
    >
  >
> {}

export const AccessReadToken = Binding.Service<AccessReadToken>("GCP.CloudBuild.AccessReadToken");

/**
 * HTTP implementation of {@link AccessReadToken}.
 *
 * @layer
 * @provides GCP.CloudBuild.AccessReadToken
 */
export const AccessReadTokenHttp = Layer.effect(
  AccessReadToken,
  Effect.gen(function* () {
    const access = yield* GCPBindings.withCredentials(
      cloudbuild.accessReadTokenProjectsLocationsConnectionsRepositories,
    );
    return yield* makeRepositoryHttpBinding<
      cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesRequest,
      cloudbuild.FetchReadTokenResponse,
      cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesError
    >({
      tag: "GCP.CloudBuild.AccessReadToken",
      iam: { role: "roles/cloudbuild.readTokenAccessor" },
      operation: (input) =>
        access({
          ...input,
          body: input.body ?? {},
        }),
    });
  }),
);
