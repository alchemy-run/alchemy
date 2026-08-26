import * as cloudbuild from "@distilled.cloud/gcp/cloudbuild_v2";
import * as Layer from "effect/Layer";
import { AccessReadToken } from "./AccessReadToken.ts";
import { makeRepositoryHttpBinding } from "./BindingHttp.ts";

/**
 * HTTP implementation of {@link AccessReadToken}.
 *
 * @layer
 * @provides GCP.CloudBuild.AccessReadToken
 */
export const AccessReadTokenHttp = Layer.effect(
  AccessReadToken,
  makeRepositoryHttpBinding<
    cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesRequest,
    cloudbuild.FetchReadTokenResponse,
    cloudbuild.AccessReadTokenProjectsLocationsConnectionsRepositoriesError
  >({
    tag: "GCP.CloudBuild.AccessReadToken",
    operation: (input) =>
      cloudbuild.accessReadTokenProjectsLocationsConnectionsRepositories({
        ...input,
        body: input.body ?? {},
      }),
  }),
);
