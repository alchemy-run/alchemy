import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { makeGitRepositoryLinkHttpBinding } from "./BindingHttp.ts";
import type { ConnectionsGitRepositoryLink } from "./ConnectionsGitRepositoryLink.ts";

export interface FetchGitRefsRequest extends Omit<
  developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksRequest,
  "gitRepositoryLink"
> {}

/**
 * Runtime binding for Developer Connect `gitRepositoryLinks.fetchGitRefs`.
 *
 * Bind this operation to a {@link ConnectionsGitRepositoryLink} in a
 * Function/Action init phase. Provide {@link FetchGitRefsHttp}.
 *
 * ### Listing Branches
 * **Example:** Fetch branch names
 * ```typescript
 * const fetchGitRefs = yield* GCP.DeveloperConnect.FetchGitRefs(source);
 * const { refNames } = yield* fetchGitRefs({ refType: "BRANCH" });
 * ```
 *
 * **Example:** Fetch tags
 * ```typescript
 * const { refNames } = yield* fetchGitRefs({ refType: "TAG", pageSize: 50 });
 * ```
 *
 * @binding
 * @category DeveloperConnect
 */
export interface FetchGitRefs extends Binding.Service<
  FetchGitRefs,
  "GCP.DeveloperConnect.FetchGitRefs",
  (
    link: ConnectionsGitRepositoryLink,
  ) => Effect.Effect<
    (
      request?: FetchGitRefsRequest,
    ) => Effect.Effect<
      developerconnect.FetchGitRefsResponse,
      developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksError,
      RuntimeContext
    >
  >
> {}

export const FetchGitRefs = Binding.Service<FetchGitRefs>("GCP.DeveloperConnect.FetchGitRefs");

/**
 * HTTP implementation of {@link FetchGitRefs}.
 *
 * @layer
 * @provides GCP.DeveloperConnect.FetchGitRefs
 */
export const FetchGitRefsHttp = Layer.effect(
  FetchGitRefs,
  makeGitRepositoryLinkHttpBinding<
    developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksRequest,
    developerconnect.FetchGitRefsResponse,
    developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksError
  >({
    tag: "GCP.DeveloperConnect.FetchGitRefs",
    iam: { role: "roles/developerconnect.user" },
    operation: Effect.gen(function* () {
      const call = yield* GCPBindings.withCredentials(
        developerconnect.fetchGitRefsProjectsLocationsConnectionsGitRepositoryLinks,
      );
      return (
        input: developerconnect.FetchGitRefsProjectsLocationsConnectionsGitRepositoryLinksRequest,
      ) => call(input);
    }),
  }),
);
