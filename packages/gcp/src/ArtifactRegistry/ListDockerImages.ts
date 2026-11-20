import * as artifactregistry from "@distilled.cloud/gcp/artifactregistry_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Repository } from "./Repository.ts";

export interface ListDockerImagesRequest extends Omit<
  artifactregistry.ListProjectsLocationsRepositoriesDockerImagesRequest,
  "parent"
> {}

/**
 * Runtime binding for Artifact Registry `dockerImages.list`.
 *
 * Bind this operation to a {@link Repository} in a Function/Action init
 * phase. Provide {@link ListDockerImagesHttp}.
 *
 * ### Listing Docker Images
 * **Example:** List images in a repository
 * ```typescript
 * const listImages = yield* GCP.ArtifactRegistry.ListDockerImages(images);
 * const page = yield* listImages({ pageSize: 50 });
 * ```
 *
 * @binding
 * @category ArtifactRegistry
 */
export interface ListDockerImages extends Binding.Service<
  ListDockerImages,
  "GCP.ArtifactRegistry.ListDockerImages",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request?: ListDockerImagesRequest,
    ) => Effect.Effect<
      artifactregistry.ListDockerImagesResponse,
      artifactregistry.ListProjectsLocationsRepositoriesDockerImagesError,
      RuntimeContext
    >
  >
> {}

export const ListDockerImages = Binding.Service<ListDockerImages>(
  "GCP.ArtifactRegistry.ListDockerImages",
);

/**
 * HTTP implementation of {@link ListDockerImages}.
 *
 * @layer
 * @provides GCP.ArtifactRegistry.ListDockerImages
 */
export const ListDockerImagesHttp = Layer.effect(
  ListDockerImages,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const listDockerImages = yield* GCPBindings.withCredentials(
      artifactregistry.listProjectsLocationsRepositoriesDockerImages,
    );
    return Effect.fn(function* (repository: Repository) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.ArtifactRegistry.ListDockerImages(${repository})`({
          iam: [
            grantFor(
              {
                role: "roles/artifactregistry.reader",
                on: "artifactregistry.repository",
              },
              repository.name,
            ),
          ],
        });
      }
      const name = yield* repository.name;
      return Effect.fn(`GCP.ArtifactRegistry.ListDockerImages(${repository.LogicalId})`)(function* (
        request?: ListDockerImagesRequest,
      ) {
        return yield* listDockerImages({
          ...request,
          parent: yield* name,
        });
      });
    });
  }),
);
