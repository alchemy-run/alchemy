import { HarborCredentials, harborCredentialsOf } from "@distilled.cloud/stackit/Credentials";
import * as registry from "@distilled.cloud/stackit/registry";
import * as harbor from "@distilled.cloud/stackit/registry_harbor";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { getServiceStatus } from "../internal/enable.ts";

/** The STACKIT service id Container Registry is enabled under. */
export const REGISTRY_SERVICE_ID = "cloud.stackit.container-registry";

/** Budget for a registry project to settle; the API reports no typical time. */
export const REGISTRY_TIMEOUT = "5 minutes";

/** Longest generated registry project name: it is part of every image path. */
export const REGISTRY_NAME_MAX_LENGTH = 63;

/** Longest generated robot account name. */
export const ROBOT_NAME_MAX_LENGTH = 63;

/** Bound on hand-paged lists: 1000 pages of 100 is far beyond any real project. */
const MAX_PAGES = 1000;

const PAGE_SIZE = 100;

/**
 * A hand-paged list outgrew {@link MAX_PAGES}. Failing beats a silently partial
 * answer, which would hide resources from `read`, `list` and `forceDestroy`.
 */
export class ContainerRegistryListTooLong extends Data.TaggedError(
  "Stackit.ContainerRegistry.ListTooLong",
)<{
  readonly list: string;
  readonly message: string;
}> {}

const tooLong = (list: string) =>
  new ContainerRegistryListTooLong({
    list,
    message: `${list} did not finish within ${MAX_PAGES} pages`,
  });

/** Whether Container Registry is enabled for a project: a project that isn't has no registries. */
export const isRegistryEnabled = (projectId: string, region: string) =>
  getServiceStatus({ projectId, region, serviceId: REGISTRY_SERVICE_ID }).pipe(
    Effect.map((status) => status.state === "ENABLED"),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

/** A registry project STACKIT still lists after deleting it counts as gone. */
export const isGoneArtifactory = (artifactory: registry.Artifactory | undefined) =>
  artifactory === undefined || artifactory.state === "Deleted";

/** Read a registry project by id; `undefined` when it is missing or deleted. */
export const getArtifactoryOrUndefined = (
  projectId: string,
  region: string,
  artifactoryId: string,
) =>
  registry.getArtifactory({ projectId, regionId: region, artifactoryId }).pipe(
    Effect.map((artifactory) => (isGoneArtifactory(artifactory) ? undefined : artifactory)),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

/**
 * Every live registry project of a STACKIT project. The operation has no
 * pagination trait, so this follows `next_page_token` by hand.
 */
export const listArtifactories = (projectId: string, region: string) =>
  Effect.gen(function* () {
    const found: registry.Artifactory[] = [];
    let token: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response: registry.ArtifactoryList = yield* registry.listArtifactories({
        projectId,
        regionId: region,
        page_size: PAGE_SIZE,
        ...(token !== undefined ? { next_page_token: token } : {}),
      });
      found.push(...response.artifactories.filter((item) => !isGoneArtifactory(item)));
      token = response.next_page_token === "" ? undefined : response.next_page_token;
      if (token === undefined) return found;
    }
    return yield* tooLong(`registry projects of ${projectId}`);
  });

/** The live registry project with a given name, if any. */
export const findArtifactoryByName = (projectId: string, region: string, name: string) =>
  listArtifactories(projectId, region).pipe(
    Effect.map((artifactories) => artifactories.find((item) => item.name === name)),
  );

/**
 * The host image references use, from the project's `url` (with or without a
 * scheme or path).
 */
export const registryHostOf = (url: string): string =>
  url.replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");

/** The Basic-auth identity Harbor's API is called with. */
export interface HarborCredentialsInput {
  /**
   * A robot account (`robot$<project>+<name>`), or a Harbor username.
   */
  username: string;
  /**
   * The robot's secret, or the CLI secret from the user's profile in the
   * registry UI.
   */
  secret: Redacted.Redacted<string>;
}

/** Sign a `registry_harbor` call with one identity against one registry. */
export const withHarbor =
  (registryUrl: string, credentials: HarborCredentialsInput) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(
      effect,
      HarborCredentials,
      harborCredentialsOf({
        registryUrl,
        username: credentials.username,
        secret: credentials.secret,
      }),
    );

/**
 * Page a `registry_harbor` list: its bodies are bare arrays with the total in a
 * header, so a page shorter than the page size is the last.
 */
export const listAllPages = <A, E, R>(
  list: string,
  page: (input: {
    readonly page: number;
    readonly page_size: number;
  }) => Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  Effect.gen(function* () {
    const found: A[] = [];
    for (let number = 1; number <= MAX_PAGES; number++) {
      const items: ReadonlyArray<A> = yield* page({ page: number, page_size: PAGE_SIZE });
      found.push(...items);
      if (items.length < PAGE_SIZE) return found;
    }
    return yield* tooLong(list);
  });

/**
 * A repository as Harbor's path takes it: without the project prefix Harbor's
 * own listings put on `name`, and URL-encoded once. Distilled encodes every path
 * label once more, which gives the double encoding Harbor documents for
 * `a/b` (`a%252Fb`).
 */
export const repositoryLabel = (project: string, repository: string): string =>
  encodeURIComponent(
    repository.startsWith(`${project}/`) ? repository.slice(project.length + 1) : repository,
  );

/**
 * Empty a registry project: deleting a repository deletes its artifacts. A
 * repository that is already gone is fine.
 */
export const deleteAllRepositories = (project: string) =>
  Effect.gen(function* () {
    const repositories = yield* listAllPages(`repositories of ${project}`, (page) =>
      harbor.listRepositories({ project_name: project, ...page }),
    );
    yield* Effect.forEach(
      repositories,
      (repository) =>
        repository.name === undefined
          ? Effect.void
          : harbor
              .deleteRepository({
                project_name: project,
                repository_name: repositoryLabel(project, repository.name),
              })
              .pipe(Effect.catchTag("NotFound", () => Effect.void)),
      { concurrency: 4, discard: true },
    );
  });

/**
 * Whether an image tag is already in a repository, for an image pipeline that
 * skips the build and push when it is (`ImageRegistryTarget.hasTag` in
 * `@alchemy.run/docker`). The identity needs `artifact:read`.
 */
export const hasImageTag = (input: {
  readonly registryUrl: string;
  readonly project: string;
  readonly repository: string;
  readonly tag: string;
  readonly credentials: HarborCredentialsInput;
}) =>
  harbor
    .getArtifact({
      project_name: input.project,
      repository_name: repositoryLabel(input.project, input.repository),
      reference: input.tag,
    })
    .pipe(
      Effect.as(true),
      Effect.catchTag("NotFound", () => Effect.succeed(false)),
      withHarbor(input.registryUrl, input.credentials),
    );
