import * as codeartifact from "@distilled.cloud/aws/codeartifact";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeRepositoryHttpBinding, packageArns } from "./BindingHttp.ts";
import type { Repository } from "./Repository.ts";

/**
 * Request for {@link PublishPackageVersion} — `domain`, `domainOwner`, and
 * `repository` are injected from the bound {@link Repository}.
 */
export interface PublishPackageVersionRequest extends Omit<
  codeartifact.PublishPackageVersionRequest,
  "domain" | "domainOwner" | "repository"
> {}

/**
 * Runtime binding for `codeartifact:PublishPackageVersion`.
 *
 * Publishes a new package version (generic-format packages) by uploading an asset with its SHA-256 checksum. Provide the implementation with
 * `Effect.provide(AWS.CodeArtifact.PublishPackageVersionHttp)`.
 * ### Publishing Packages
 * **Example:** Publish a Generic Package Version
 * ```typescript
 * const publish = yield* AWS.CodeArtifact.PublishPackageVersion(repo);
 *
 * const res = yield* publish({
 *   format: "generic",
 *   namespace: "my-ns",
 *   package: "my-package",
 *   packageVersion: "1.0.0",
 *   assetName: "artifact.bin",
 *   assetContent: bytes,
 *   assetSHA256: sha256HexOfBytes,
 * });
 * console.log(res.status);
 * ```
 *
 * @binding
 */
export interface PublishPackageVersion extends Binding.Service<
  PublishPackageVersion,
  "AWS.CodeArtifact.PublishPackageVersion",
  (
    repository: Repository,
  ) => Effect.Effect<
    (
      request: PublishPackageVersionRequest,
    ) => Effect.Effect<
      codeartifact.PublishPackageVersionResult,
      codeartifact.PublishPackageVersionError
    >
  >
> {}

export const PublishPackageVersion = Binding.Service<PublishPackageVersion>(
  "AWS.CodeArtifact.PublishPackageVersion",
);

/** HTTP implementation of {@link PublishPackageVersion} over the CodeArtifact API. */
export const PublishPackageVersionHttp = Layer.effect(
  PublishPackageVersion,
  makeRepositoryHttpBinding({
    tag: "AWS.CodeArtifact.PublishPackageVersion",
    operation: codeartifact.publishPackageVersion,
    actions: ["codeartifact:PublishPackageVersion"],
    resources: packageArns,
  }),
);
