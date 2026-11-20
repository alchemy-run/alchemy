import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { makeGitRepositoryLinkHttpBinding } from "./BindingHttp.ts";
import type { ConnectionsGitRepositoryLink } from "./ConnectionsGitRepositoryLink.ts";

export interface FetchReadTokenRequest extends Omit<
  developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
  "gitRepositoryLink"
> {}

/**
 * Runtime binding for Developer Connect `gitRepositoryLinks.fetchReadToken`.
 *
 * Bind this operation to a {@link ConnectionsGitRepositoryLink} in a
 * Function/Action init phase. Provide {@link FetchReadTokenHttp}.
 * Returns a short-lived token that can clone the remote Git repository.
 *
 * ### Fetching a Read Token
 * **Example:** Clone with a read token
 * ```typescript
 * const fetchReadToken = yield* GCP.DeveloperConnect.FetchReadToken(source);
 * const { token, expirationTime } = yield* fetchReadToken();
 * ```
 *
 * @binding
 * @category DeveloperConnect
 */
export interface FetchReadToken extends Binding.Service<
  FetchReadToken,
  "GCP.DeveloperConnect.FetchReadToken",
  (
    link: ConnectionsGitRepositoryLink,
  ) => Effect.Effect<
    (
      request?: FetchReadTokenRequest,
    ) => Effect.Effect<
      developerconnect.FetchReadTokenResponse,
      developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksError,
      RuntimeContext
    >
  >
> {}

export const FetchReadToken = Binding.Service<FetchReadToken>(
  "GCP.DeveloperConnect.FetchReadToken",
);

/**
 * HTTP implementation of {@link FetchReadToken}.
 *
 * @layer
 * @provides GCP.DeveloperConnect.FetchReadToken
 */
export const FetchReadTokenHttp = Layer.effect(
  FetchReadToken,
  makeGitRepositoryLinkHttpBinding<
    developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
    developerconnect.FetchReadTokenResponse,
    developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksError
  >({
    tag: "GCP.DeveloperConnect.FetchReadToken",
    iam: { role: "roles/developerconnect.readTokenAccessor" },
    operation: Effect.gen(function* () {
      const call = yield* GCPBindings.withCredentials(
        developerconnect.fetchReadTokenProjectsLocationsConnectionsGitRepositoryLinks,
      );
      return (
        input: developerconnect.FetchReadTokenProjectsLocationsConnectionsGitRepositoryLinksRequest,
      ) => call(input);
    }),
  }),
);
