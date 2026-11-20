import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { makeGitRepositoryLinkHttpBinding } from "./BindingHttp.ts";
import type { ConnectionsGitRepositoryLink } from "./ConnectionsGitRepositoryLink.ts";

export interface FetchReadWriteTokenRequest extends Omit<
  developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
  "gitRepositoryLink"
> {}

/**
 * Runtime binding for Developer Connect
 * `gitRepositoryLinks.fetchReadWriteToken`.
 *
 * Bind this operation to a {@link ConnectionsGitRepositoryLink} in a
 * Function/Action init phase. Provide {@link FetchReadWriteTokenHttp}.
 * Returns a short-lived token that can clone and push to the remote
 * Git repository.
 *
 * ### Fetching a Read/Write Token
 * **Example:** Push with a read/write token
 * ```typescript
 * const fetchReadWriteToken = yield* GCP.DeveloperConnect.FetchReadWriteToken(
 *   source,
 * );
 * const { token, expirationTime } = yield* fetchReadWriteToken();
 * ```
 *
 * @binding
 * @category DeveloperConnect
 */
export interface FetchReadWriteToken extends Binding.Service<
  FetchReadWriteToken,
  "GCP.DeveloperConnect.FetchReadWriteToken",
  (
    link: ConnectionsGitRepositoryLink,
  ) => Effect.Effect<
    (
      request?: FetchReadWriteTokenRequest,
    ) => Effect.Effect<
      developerconnect.FetchReadWriteTokenResponse,
      developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksError,
      RuntimeContext
    >
  >
> {}

export const FetchReadWriteToken = Binding.Service<FetchReadWriteToken>(
  "GCP.DeveloperConnect.FetchReadWriteToken",
);

/**
 * HTTP implementation of {@link FetchReadWriteToken}.
 *
 * @layer
 * @provides GCP.DeveloperConnect.FetchReadWriteToken
 */
export const FetchReadWriteTokenHttp = Layer.effect(
  FetchReadWriteToken,
  makeGitRepositoryLinkHttpBinding<
    developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
    developerconnect.FetchReadWriteTokenResponse,
    developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksError
  >({
    tag: "GCP.DeveloperConnect.FetchReadWriteToken",
    iam: { role: "roles/developerconnect.tokenAccessor" },
    operation: Effect.gen(function* () {
      const call = yield* GCPBindings.withCredentials(
        developerconnect.fetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinks,
      );
      return (
        input: developerconnect.FetchReadWriteTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
      ) => call(input);
    }),
  }),
);
