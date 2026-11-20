import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";
import type { Repository } from "./Repository.ts";

export interface AccessReadWriteTokenRequest extends Omit<
  cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesRequest,
  "repository"
> {}

/**
 * Runtime binding for Cloud Build v2 `repositories.accessReadWriteToken`.
 *
 * Bind this operation to a {@link Repository} in a Function/Action init
 * phase. Provide {@link AccessReadWriteTokenHttp}. Returns a short-lived
 * token that can clone and push to the remote Git repository.
 *
 * ### Fetching a Read/Write Token
 * **Example:** Push with a read/write token
 * ```typescript
 * const accessReadWriteToken = yield* GCP.CloudBuild.AccessReadWriteToken(source);
 * const { token, expirationTime } = yield* accessReadWriteToken();
 * ```
 *
 * @binding
 * @category CloudBuild
 */
export interface AccessReadWriteToken extends Binding.Service<
  AccessReadWriteToken,
  "GCP.CloudBuild.AccessReadWriteToken",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: AccessReadWriteTokenRequest,
    ) => Effect.Effect<
      cloudbuild.FetchReadWriteTokenResponse,
      cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesError,
      RuntimeContext
    >
  >
> {}

export const AccessReadWriteToken = Binding.Service<AccessReadWriteToken>(
  "GCP.CloudBuild.AccessReadWriteToken",
);

/**
 * HTTP implementation of {@link AccessReadWriteToken}.
 *
 * @layer
 * @provides GCP.CloudBuild.AccessReadWriteToken
 */
export const AccessReadWriteTokenHttp = Layer.effect(
  AccessReadWriteToken,
  Effect.gen(function* () {
    const access = yield* GCPBindings.withCredentials(
      cloudbuild.accessReadWriteTokenProjectsLocationsConnectionsRepositories,
    );
    return yield* makeRepositoryHttpBinding<
      cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesRequest,
      cloudbuild.FetchReadWriteTokenResponse,
      cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesError
    >({
      tag: "GCP.CloudBuild.AccessReadWriteToken",
      iam: { role: "roles/cloudbuild.tokenAccessor" },
      operation: (input) =>
        access({
          ...input,
          body: input.body ?? {},
        }),
    });
  }),
);
