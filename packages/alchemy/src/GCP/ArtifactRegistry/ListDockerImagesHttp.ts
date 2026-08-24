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
    return Effect.fn(function* <T extends Repository>(repository: T) {
      const name = yield* repository.name;
      return Effect.fn(
        `GCP.ArtifactRegistry.ListDockerImages(${repository.LogicalId})`,
      )(function* (request?: ListDockerImagesRequest) {
        return yield* artifactregistry
          .listProjectsLocationsRepositoriesDockerImages({
            ...request,
            parent: yield* name,
          })
          .pipe(
            Effect.provideService(Credentials, credentials),
            Effect.provideService(HttpClient.HttpClient, httpClient),
          );
      });
    });
  }),
);
