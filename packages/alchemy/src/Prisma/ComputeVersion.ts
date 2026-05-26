import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { sha256, sha256Object } from "../Util/sha256.ts";
import {
  PrismaClient,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import {
  destroyComputeVersion,
  isConflict,
  waitForComputeVersionStatus,
} from "./ComputeLifecycle.ts";
import { observeComputeVersion } from "./Internal/ComputeVersionObserve.ts";
import { tailComputeVersionLogs } from "./PrismaLogs.ts";
import type { ComputeService } from "./ComputeService.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveComputeServiceId,
  unresolvedComputeServiceIdOf,
} from "./Refs.ts";
import type { ComputeVersion as ApiComputeVersion } from "./Types.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

type ObservedComputeVersion = Omit<ApiComputeVersion, "createdAt"> & {
  createdAt?: string;
};

export interface ComputeVersionProps {
  /**
   * Compute service ID or Prisma.ComputeService resource that owns this version.
   */
  computeService: string | ComputeService;
  /**
   * Port mapping diff for the version.
   */
  portMapping?: { http?: number | null };
  /**
   * Create the version by reusing the latest artifact instead of uploading code.
   */
  skipCodeUpload?: boolean;
  /**
   * Optional artifact bytes to upload to the pre-signed upload URL.
   */
  artifact?: string | Uint8Array;
  /**
   * Path to a pre-created artifact file to upload to the pre-signed upload URL.
   * Mutually exclusive with artifact.
   */
  artifactPath?: string;
  /**
   * Content type for artifact uploads.
   *
   * @default "application/octet-stream"
   */
  artifactContentType?: string;
  /**
   * Start the version after it is created.
   *
   * @default false
   */
  start?: boolean;
  /**
   * Promote the version to the service's stable endpoint after start.
   *
   * @default false
   */
  promote?: boolean;
}

export interface ComputeVersion extends Resource<
  "Prisma.ComputeVersion",
  ComputeVersionProps,
  {
    /**
     * Prisma compute version ID.
     */
    computeVersionId: string;
    /**
     * Compute service ID that owns the version.
     */
    computeServiceId: string;
    /**
     * Underlying Foundry version ID.
     */
    foundryVersionId: string;
    /**
     * Current compute version status, when observed.
     */
    status: string | undefined;
    /**
     * Preview endpoint domain for the version.
     */
    previewDomain: string | null | undefined;
    /**
     * Pre-signed artifact upload URL returned during creation.
     */
    uploadUrl: string | null | undefined;
    /**
     * Hash of the artifact bytes uploaded for this version, when Alchemy
     * uploaded an artifact.
     */
    artifactHash?: string;
    /**
     * Stable service endpoint domain after promotion.
     */
    serviceEndpointDomain: string | undefined;
    /**
     * ISO timestamp when the version was created, when observed.
     */
    createdAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Prisma compute version.
 *
 * @section Creating a Version
 * @example Fork the latest uploaded artifact
 * ```typescript
 * const version = yield* Prisma.ComputeVersion("web-v2", {
 *   computeService: service.computeServiceId,
 *   skipCodeUpload: true,
 *   start: true,
 *   promote: true,
 * });
 * ```
 *
 * @example Upload a prebuilt artifact
 * ```typescript
 * const version = yield* Prisma.ComputeVersion("web-v3", {
 *   computeService: service.computeServiceId,
 *   artifactPath: "./dist/app.tar.gz",
 *   artifactContentType: "application/gzip",
 *   start: true,
 *   promote: true,
 * });
 * ```
 */
export const ComputeVersion = Resource<ComputeVersion>("Prisma.ComputeVersion");

const findVersion = (
  client: PrismaManagementClient,
  computeServiceId: string,
  foundryVersionId: string | undefined,
) =>
  foundryVersionId === undefined
    ? Effect.succeed(undefined)
    : client
        .listServiceComputeVersions(computeServiceId, { limit: 100 })
        .pipe(
          Effect.map((versions) =>
            versions.find(
              (v: { foundryVersionId: string }) =>
                v.foundryVersionId === foundryVersionId,
            ),
          ),
        );

const attrsFrom = (
  version: ObservedComputeVersion,
  computeServiceId: string,
  extra?: {
    uploadUrl?: string | null;
    artifactHash?: string;
    serviceEndpointDomain?: string;
  },
): ComputeVersion["Attributes"] => ({
  computeVersionId: version.id,
  computeServiceId,
  foundryVersionId: version.foundryVersionId,
  status: version.status,
  previewDomain: version.previewDomain,
  uploadUrl: extra?.uploadUrl,
  artifactHash: extra?.artifactHash,
  serviceEndpointDomain: extra?.serviceEndpointDomain,
  createdAt: version.createdAt,
});

export const readUploadArtifact = Effect.fn(function* (input: {
  artifact?: string | Uint8Array;
  artifactPath?: string;
}) {
  if (input.artifact !== undefined && input.artifactPath !== undefined) {
    return yield* Effect.fail(
      new Error("artifact and artifactPath are mutually exclusive."),
    );
  }
  if (input.artifactPath !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFile(path.resolve(input.artifactPath));
  }
  if (input.artifact !== undefined) {
    const artifact = input.artifact;
    return yield* Effect.sync(() =>
      typeof artifact === "string"
        ? new TextEncoder().encode(artifact)
        : artifact,
    );
  }
  return undefined;
});

const artifactHashOf = Effect.fn(function* (props: ComputeVersionProps) {
  const artifact = yield* readUploadArtifact(props);
  if (artifact === undefined) return undefined;
  return yield* sha256Object({
    artifact: yield* sha256(artifact),
    contentType: props.artifactContentType ?? "application/octet-stream",
  });
});

export const uploadArtifact = (
  uploadUrl: string,
  artifact: Uint8Array,
  contentType: string,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const res = yield* http.execute(
      HttpClientRequest.put(uploadUrl).pipe(
        HttpClientRequest.bodyUint8Array(artifact, contentType),
      ),
    );
    if (res.status < 200 || res.status >= 300) {
      const body = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.fail(
        new Error(`Prisma artifact upload failed (${res.status}): ${body}`),
      );
    }
  });

export const ComputeVersionProvider = () =>
  Provider.effect(
    ComputeVersion,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: ["computeVersionId"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          const replacementContent = {
            portMapping: news.portMapping,
            skipCodeUpload: news.skipCodeUpload,
            artifact: news.artifact,
            artifactPath: news.artifactPath,
            artifactContentType: news.artifactContentType,
          };
          if (!isResolved(replacementContent)) return undefined;
          const resolvedReplacementContent = replacementContent as Pick<
            ComputeVersionProps,
            | "portMapping"
            | "skipCodeUpload"
            | "artifact"
            | "artifactPath"
            | "artifactContentType"
          >;
          if (isPrismaDevId(output?.computeVersionId)) {
            return { action: "update" } as const;
          }
          const oldComputeServiceId = unresolvedComputeServiceIdOf(
            olds.computeService,
          );
          const newComputeServiceId = isResolved(news.computeService)
            ? unresolvedComputeServiceIdOf(news.computeService)
            : undefined;
          const oldArtifactHash = output?.artifactHash;
          const newArtifactHash = yield* artifactHashOf({
            computeService: olds.computeService,
            ...resolvedReplacementContent,
          });
          const computeServiceChanged = concreteIdsChanged(
            oldComputeServiceId,
            newComputeServiceId,
          );
          if (
            computeServiceChanged ||
            !deepEqual(
              resolvedReplacementContent.portMapping ?? {},
              olds.portMapping ?? {},
            ) ||
            (resolvedReplacementContent.skipCodeUpload ?? false) !==
              (olds.skipCodeUpload ?? false) ||
            (resolvedReplacementContent.artifact === undefined) !==
              (olds.artifact === undefined) ||
            resolvedReplacementContent.artifactPath !== olds.artifactPath ||
            resolvedReplacementContent.artifactContentType !==
              olds.artifactContentType ||
            (newArtifactHash !== undefined &&
              newArtifactHash !== oldArtifactHash)
          ) {
            return { action: "replace" } as const;
          }
          const updateProps = {
            start: news.start,
            promote: news.promote,
          };
          if (!isResolved(updateProps)) return undefined;
          const resolvedUpdateProps = updateProps as Pick<
            ComputeVersionProps,
            "start" | "promote"
          >;
          if (
            (resolvedUpdateProps.start ?? false) !== (olds.start ?? false) ||
            (resolvedUpdateProps.promote ?? false) !== (olds.promote ?? false)
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output, olds }) {
          if (isPrismaDevId(output?.computeVersionId)) return undefined;
          const computeServiceId =
            output?.computeServiceId && !isPrismaDevId(output.computeServiceId)
              ? output.computeServiceId
              : yield* resolveComputeServiceId(olds.computeService);
          const savedVersion = output?.computeVersionId
            ? yield* observeComputeVersion(
                client,
                output.computeVersionId,
              ).pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              )
            : undefined;
          const listed = savedVersion
            ? undefined
            : yield* findVersion(
                client,
                computeServiceId,
                output?.foundryVersionId,
              );
          const version =
            savedVersion ??
            (listed
              ? yield* observeComputeVersion(client, listed.id)
              : undefined);
          return version
            ? attrsFrom(version, computeServiceId, output)
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          if ((news.skipCodeUpload ?? false) && news.artifact !== undefined) {
            return yield* Effect.fail(
              new Error("skipCodeUpload cannot be combined with artifact."),
            );
          }
          if (
            (news.skipCodeUpload ?? false) &&
            news.artifactPath !== undefined
          ) {
            return yield* Effect.fail(
              new Error("skipCodeUpload cannot be combined with artifactPath."),
            );
          }
          const artifact = yield* readUploadArtifact(news);
          const artifactHash =
            artifact === undefined
              ? output?.artifactHash
              : yield* sha256Object({
                  artifact: yield* sha256(artifact),
                  contentType:
                    news.artifactContentType ?? "application/octet-stream",
                });
          const computeServiceId = yield* resolveComputeServiceId(
            news.computeService,
          );
          let createdUploadUrl: string | null | undefined;
          const computeVersionId = isPrismaDevId(output?.computeVersionId)
            ? undefined
            : output?.computeVersionId;
          let version: ObservedComputeVersion | undefined = computeVersionId
            ? yield* observeComputeVersion(client, computeVersionId).pipe(
                Effect.catchIf(isNotFound, () => Effect.succeed(undefined)),
              )
            : undefined;

          if (!version) {
            const created = yield* client.createServiceComputeVersion(
              computeServiceId,
              {
                portMapping: news.portMapping,
                skipCodeUpload: news.skipCodeUpload,
              },
            );
            createdUploadUrl = created.uploadUrl;
            const cleanupCreatedVersion = destroyComputeVersion(
              client,
              created.id,
            ).pipe(Effect.catch(() => Effect.void));
            if (artifact !== undefined && !created.uploadUrl) {
              yield* cleanupCreatedVersion;
              return yield* Effect.fail(
                new Error(
                  "Prisma Compute version creation did not return an upload URL.",
                ),
              );
            }
            if (created.uploadUrl && artifact !== undefined) {
              yield* uploadArtifact(
                created.uploadUrl,
                artifact,
                news.artifactContentType ?? "application/octet-stream",
              ).pipe(
                Effect.catch((error) =>
                  cleanupCreatedVersion.pipe(
                    Effect.andThen(() => Effect.fail(error)),
                  ),
                ),
              );
            }
            version = yield* observeComputeVersion(client, created.id).pipe(
              Effect.catchIf(isNotFound, () =>
                Effect.succeed({
                  id: created.id,
                  type: "compute-version" as const,
                  url: created.url,
                  foundryVersionId: created.foundryVersionId,
                  status: "new",
                  previewDomain: null,
                  createdAt: undefined,
                }),
              ),
            );
          }

          let serviceEndpointDomain = output?.serviceEndpointDomain;
          if (news.start ?? false) {
            if (
              version.status !== "running" &&
              version.status !== "provisioning"
            ) {
              const started = yield* client
                .startComputeVersion(version.id)
                .pipe(
                  Effect.catchIf(
                    (e) => isNotFound(e) || isConflict(e),
                    () => Effect.succeed(undefined),
                  ),
                );
              if (started) {
                version = { ...version, previewDomain: started.previewDomain };
              }
            }
            version = yield* waitForComputeVersionStatus(
              client,
              version.id,
              "running",
            );
          }
          if (news.promote ?? false) {
            const promoted = yield* client.promoteComputeService(
              computeServiceId,
              version.id,
            );
            serviceEndpointDomain = promoted.serviceEndpointDomain;
          }

          return attrsFrom(version, computeServiceId, {
            uploadUrl: createdUploadUrl ?? output?.uploadUrl,
            artifactHash,
            serviceEndpointDomain,
          });
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.computeVersionId)) return;
          yield* destroyComputeVersion(client, output.computeVersionId);
        }),
        tail: ({ output }) =>
          output.computeVersionId
            ? tailComputeVersionLogs(client, output.computeVersionId)
            : Stream.empty,
      };
    }),
  );
