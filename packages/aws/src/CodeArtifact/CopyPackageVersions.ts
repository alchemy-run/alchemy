import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { domainWideArns } from "./BindingHttp.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link CopyPackageVersions} — `domain`, `domainOwner`, and
 * `destinationRepository` are injected from the bound {@link Repository};
 * `sourceRepository` names a sibling repository in the same domain.
 */
export interface CopyPackageVersionsRequest extends Omit<
  codeartifact.CopyPackageVersionsRequest,
  "domain" | "domainOwner" | "destinationRepository"
> {}

/**
 * Runtime binding for `codeartifact:CopyPackageVersions`.
 *
 * Copies package versions from another repository in the same domain into the
 * bound repository (the destination) — the standard promotion flow from a
 * staging repository to a release repository. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.CopyPackageVersionsHttp)`.
 * ### Promoting Packages
 * **Example:** Promote a Version from Staging
 * ```typescript
 * const copyVersions = yield* AWS.CodeArtifact.CopyPackageVersions(releaseRepo);
 *
 * const res = yield* copyVersions({
 *   sourceRepository: "staging",
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   versions: ["1.0.0"],
 * });
 * console.log(res.successfulVersions);
 * ```
 *
 * @binding
 */
export interface CopyPackageVersions extends Binding.Service<
  CopyPackageVersions,
  "AWS.CodeArtifact.CopyPackageVersions",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: CopyPackageVersionsRequest,
    ) => Effect.Effect<
      codeartifact.CopyPackageVersionsResult,
      codeartifact.CopyPackageVersionsError
    >
  >
> {}

export const CopyPackageVersions = Binding.Service<CopyPackageVersions>(
  "AWS.CodeArtifact.CopyPackageVersions",
);

/**
 * HTTP implementation of {@link CopyPackageVersions} over the CodeArtifact
 * API. Bespoke (not the shared repository scaffolding): the bound repository
 * is injected as `destinationRepository`, and the copy also reads from the
 * caller-chosen source repository, so the grant spans every repository and
 * package in the domain.
 */
export const CopyPackageVersionsHttp = Layer.effect(
  CopyPackageVersions,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    const op = yield* AWSBindings.withCredentials(codeartifact.copyPackageVersions);

    return Effect.fn(function* (repository: Repository) {
      const DomainName = yield* repository.domainName;
      const DomainOwner = yield* repository.domainOwner;
      const RepositoryName = yield* repository.repositoryName;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.CodeArtifact.CopyPackageVersions(${repository})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "codeartifact:CopyPackageVersions",
                // The copy reads version metadata and assets from the
                // source repository on the caller's behalf.
                "codeartifact:ReadFromRepository",
                "codeartifact:DescribePackageVersion",
              ],
              Resource: domainWideArns(repository),
            },
          ],
        });
      }
      return Effect.fn(`AWS.CodeArtifact.CopyPackageVersions(${repository.LogicalId})`)(function* (
        request: CopyPackageVersionsRequest,
      ) {
        const owner = yield* DomainOwner;
        return yield* op({
          ...request,
          domain: yield* DomainName,
          ...(owner === "" ? {} : { domainOwner: owner }),
          destinationRepository: yield* RepositoryName,
        });
      });
    });
  }),
);
