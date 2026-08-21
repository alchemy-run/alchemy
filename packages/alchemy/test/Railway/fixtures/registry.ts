/**
 * Effect-native Railway.Service images must be pushed to a registry
 * Railway can pull (`registry` + RAILWAY_REGISTRY_USERNAME/PASSWORD,
 * GITHUB_ACTOR/GITHUB_TOKEN, or Docker Hub). Doppler currently ships
 * only RAILWAY_API_TOKEN, so docker push is impossible in the default
 * testing profile. Fixtures still exist; tests fall back to a public
 * image (`hashicorp/http-echo`) plus packed env.
 */
export const railwayRegistry = process.env.RAILWAY_REGISTRY;

const present = (value: string | undefined): boolean =>
  value !== undefined && value.length > 0;

export const canPushRailwayImage =
  present(railwayRegistry) &&
  ((present(process.env.RAILWAY_REGISTRY_USERNAME) &&
    present(process.env.RAILWAY_REGISTRY_PASSWORD)) ||
    (present(process.env.GITHUB_ACTOR) && present(process.env.GITHUB_TOKEN)) ||
    (present(process.env.DOCKERHUB_USERNAME) &&
      (present(process.env.DOCKERHUB_TOKEN) ||
        present(process.env.DOCKER_PASSWORD))));
