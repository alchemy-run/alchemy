import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Layer from "effect/Layer";
import { AccessReadWriteToken } from "./AccessReadWriteToken.ts";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link AccessReadWriteToken}.
 *
 * @layer
 * @provides GCP.CloudBuild.AccessReadWriteToken
 */
export const AccessReadWriteTokenHttp = Layer.effect(
  AccessReadWriteToken,
  makeRepositoryHttpBinding<
    cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesRequest,
    cloudbuild.FetchReadWriteTokenResponse,
    cloudbuild.AccessReadWriteTokenProjectsLocationsConnectionsRepositoriesError
  >({
    tag: "GCP.CloudBuild.AccessReadWriteToken",
    operation: (input) =>
      cloudbuild.accessReadWriteTokenProjectsLocationsConnectionsRepositories({
        ...input,
        body: input.body ?? {},
      }),
  }),
);
