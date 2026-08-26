import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  ListDockerImages,
  type ListDockerImagesRequest,
} from "./ListDockerImages.ts";
import type { Repository } from "./Repository.ts";

const listDockerImages = (
  input: artifactregistry.ListProjectsLocationsRepositoriesDockerImagesRequest,
): Effect.Effect<
  artifactregistry.ListDockerImagesResponse,
  artifactregistry.ListProjectsLocationsRepositoriesDockerImagesError,
  Credentials | HttpClient.HttpClient
> => artifactregistry.listProjectsLocationsRepositoriesDockerImages(input);

/**
 * HTTP implementation of {@link ListDockerImages}.
 *
 * @layer
 * @provides GCP.ArtifactRegistry.ListDockerImages
 */
export const ListDockerImagesHttp = Layer.effect(
  ListDockerImages,
  Effect.gen(function* () {
    const credentials = yield* Credentials;
    const httpClient = yield* HttpClient.HttpClient;
    return Effect.fn(function* (repository: Repository) {
      const name = yield* repository.name;
      return Effect.fn(
        `GCP.ArtifactRegistry.ListDockerImages(${repository.LogicalId})`,
      )(function* (request?: ListDockerImagesRequest) {
        return yield* listDockerImages({
          ...request,
          parent: yield* name,
        }).pipe(
          Effect.provideService(Credentials, credentials),
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
      });
    });
  }),
);
