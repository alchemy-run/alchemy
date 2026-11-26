import type { BuildCacheOptions } from "@alchemy.run/docker/BuildCache";
import * as lambdacore from "@distilled.cloud/aws/lambda-core";
import { isResolved } from "alchemy/Diff";
import type { Input } from "alchemy/Input";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { ScopedPlanStatusSession } from "alchemy/Report";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";
import { makeFunctionImage, type FunctionImageSource } from "./FunctionImage.ts";
import type { Runtime } from "./Runtime.ts";
import { recoveryWindowOf } from "./RuntimeLifecycle.ts";

interface RuntimeVersionCommonProps {
  /** The runtime this version belongs to. */
  runtime: Runtime;
  /**
   * The version name: letters, numbers, `-`, `_` and `.`, up to 128
   * characters. If omitted, a unique name is generated. Changing it
   * replaces the version.
   */
  name?: string;
  /** Release notes shown to consumers. Can change without a new version. */
  releaseNotes?: string;
  /**
   * Days (7–30) Lambda keeps the version restorable after Alchemy deletes
   * it. The name stays reserved for that long.
   * @default 30
   */
  recoveryWindowInDays?: number;
}

export interface RuntimeVersionImageProps extends RuntimeVersionCommonProps {
  /**
   * A private ECR image URI with a tag or digest, in the runtime's region,
   * e.g. `image.imageUri` from an `AWS.ECR.Image`. Lambda resolves a tag to
   * a digest once, when it creates the version, so pin a digest to make the
   * version's contents explicit. The repository policy must let
   * `lambda.amazonaws.com` read the image.
   */
  image: string;
  context?: never;
  dockerfile?: never;
  buildArgs?: never;
  cache?: never;
  architecture?: never;
}

export interface RuntimeVersionBuildProps extends RuntimeVersionCommonProps {
  image?: never;
  /**
   * A Docker build context. Alchemy builds it, pushes it to an ECR
   * repository it manages for this version, and grants Lambda read access.
   * The image holds the OS, the language, a `bootstrap` and the runtime
   * interface client; start from a Lambda base image such as
   * `public.ecr.aws/lambda/nodejs:24`.
   */
  context: string;
  /**
   * The Dockerfile path, relative to {@link context} unless absolute.
   * @default "Dockerfile"
   */
  dockerfile?: string;
  /**
   * Docker build arguments (`--build-arg`). They are stored in deployment
   * state and may be kept in image layers, so never pass secrets.
   */
  buildArgs?: Record<string, string>;
  /**
   * Keep build layers in a remote cache so a fresh builder skips unchanged
   * steps. `true` keeps them at the repository's `:buildcache` tag.
   * @default false
   */
  cache?: BuildCacheOptions["cache"];
  /**
   * The architecture to build for. Functions on this version must use it.
   * @default "x86_64"
   */
  architecture?: "x86_64" | "arm64";
}

export type RuntimeVersionProps = RuntimeVersionImageProps | RuntimeVersionBuildProps;

export interface RuntimeVersion extends Resource<
  "AWS.Lambda.RuntimeVersion",
  RuntimeVersionProps,
  {
    /** The version ARN. */
    versionArn: string;
    /** The version name. */
    versionName: string;
    /** The ARN of the runtime the version belongs to. */
    runtimeArn: string;
    /** The name of the runtime the version belongs to. */
    runtimeName: string;
    /** The digest-pinned image URI Lambda created the version from. */
    resolvedUri: string;
    /** The architectures the version's image supports. */
    architectures: string[];
    /** The version state, e.g. `ACTIVE`. */
    state: string;
    /** The version's release notes. */
    releaseNotes?: string;
    /** The image Alchemy built or resolved, and whether it owns its repository. */
    image: {
      /** `build` for a `context`, `uri` for an `image`. */
      source: "build" | "uri";
      /** The identity of the image: its build hash or requested URI and digest. */
      hash: string;
      /** The ECR repository holding the image. */
      repositoryName: string;
      /** Whether Alchemy owns the repository and deletes it with the version. */
      ownsRepository: boolean;
    };
  },
  never,
  Providers,
  RuntimeVersionLookup
> {}

/** Props for {@link RuntimeVersion.lookup}. */
export interface RuntimeVersionLookup {
  /** The runtime's name or ARN. A runtime in another account needs its ARN. */
  runtime: string;
  /** The version name. */
  name: string;
}

/**
 * An immutable version of a {@link Runtime}, made from one container image.
 *
 * To change a runtime's contents, create a new version and point a
 * {@link RuntimeAlias} at it. Changing the image replaces the version, so
 * an alias that references it moves to the new version on the same deploy.
 *
 * ### Building a version
 * **Example:** Build from a Dockerfile
 * ```typescript
 * const v1 = yield* AWS.Lambda.RuntimeVersion("NodeV1", {
 *   runtime,
 *   context: "./runtime",
 *   releaseNotes: "Node.js 24.11 with the company CA bundle",
 * });
 * ```
 *
 * The Dockerfile starts from a Lambda base image and adds what the runtime
 * needs:
 *
 * ```dockerfile
 * FROM public.ecr.aws/lambda/nodejs:24
 * COPY company-ca.pem /etc/pki/ca-trust/source/anchors/
 * RUN update-ca-trust
 * ```
 *
 * **Example:** Build for arm64
 * ```typescript
 * const v1 = yield* AWS.Lambda.RuntimeVersion("NodeV1Arm", {
 *   runtime,
 *   context: "./runtime",
 *   architecture: "arm64",
 * });
 * ```
 *
 * ### Using an existing image
 * **Example:** Create a version from an ECR image
 * ```typescript
 * const v1 = yield* AWS.Lambda.RuntimeVersion("NodeV1", {
 *   runtime,
 *   image: "123456789012.dkr.ecr.us-east-1.amazonaws.com/node-runtime@sha256:4f6a…",
 * });
 * ```
 *
 * @resource
 */
export const RuntimeVersion = Resource<RuntimeVersion>("AWS.Lambda.RuntimeVersion");

export class RuntimeVersionFailed extends Data.TaggedError("RuntimeVersionFailed")<{
  readonly message: string;
}> {}

export class RuntimeVersionNameReserved extends Data.TaggedError("RuntimeVersionNameReserved")<{
  readonly message: string;
}> {}

class RuntimeVersionPending extends Data.TaggedError("RuntimeVersionPending")<{
  readonly state: string;
}> {}

type ResolvedProps = Input.ResolveProps<RuntimeVersionProps>;
const resolved = (props: RuntimeVersionProps) => props as unknown as ResolvedProps;

const resolveVersionName = (id: string, name: string | undefined) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 128, delimiter: "-" });

const architectureOf = (props: ResolvedProps) => props.architecture ?? "x86_64";

const imageSourceOf = (props: ResolvedProps): FunctionImageSource =>
  props.image !== undefined
    ? { uri: props.image }
    : {
        context: props.context,
        dockerfile: props.dockerfile ?? "Dockerfile",
        ...(props.buildArgs === undefined ? {} : { buildArgs: props.buildArgs }),
        ...(props.cache === undefined ? {} : { cache: props.cache }),
      };

const getVersion = (runtime: string, name: string) =>
  lambdacore
    .getRuntimeVersion({ RuntimeName: runtime, Name: name })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

export const RuntimeVersionProvider = () =>
  Provider.effect(
    RuntimeVersion,
    Effect.gen(function* () {
      const functionImage = yield* makeFunctionImage;

      const toAttrs = (
        version: lambdacore.GetRuntimeVersionResponse,
        runtime: { runtimeArn: string; runtimeName: string },
        image: RuntimeVersion["Attributes"]["image"],
      ): RuntimeVersion["Attributes"] => ({
        versionArn: version.Arn,
        versionName: version.Name,
        runtimeArn: runtime.runtimeArn,
        runtimeName: runtime.runtimeName,
        resolvedUri: version.ResolvedUri,
        architectures: [...(version.Compatibility?.Architectures ?? [])],
        state: version.State,
        releaseNotes: version.ReleaseNotes || undefined,
        image,
      });

      const waitForActive = (runtime: string, name: string, session: ScopedPlanStatusSession) =>
        Effect.gen(function* () {
          const version = yield* lambdacore.getRuntimeVersion({
            RuntimeName: runtime,
            Name: name,
          });
          if (version.State === "ACTIVE") return version;
          if (version.State === "FAILED") {
            return yield* new RuntimeVersionFailed({
              message: `Runtime version ${name} failed. Check that Lambda can read ${version.ResolvedUri} and that it is a valid runtime image (a bootstrap and a runtime interface client).`,
            });
          }
          return yield* new RuntimeVersionPending({ state: version.State });
        }).pipe(
          Effect.retry({
            while: (e) => e._tag === "RuntimeVersionPending",
            schedule: Schedule.spaced("5 seconds").pipe(
              Schedule.tap(() => session.note(`Waiting for runtime version ${name}...`)),
            ),
            times: 36,
          }),
        );

      return {
        stables: ["versionArn", "versionName", "runtimeArn", "runtimeName"],

        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return;
          const n = resolved(news);
          const o = resolved(olds);
          if (output === undefined || o.runtime === undefined) return;
          if (n.runtime.runtimeArn !== output.runtimeArn) {
            return { action: "replace" } as const;
          }
          if ((n.name ?? output.versionName) !== output.versionName) {
            return { action: "replace" } as const;
          }
          // A version is immutable: any change to its image is a new version.
          const source: "build" | "uri" = n.image !== undefined ? "uri" : "build";
          if (source !== output.image.source) {
            return { action: "replace" } as const;
          }
          if (source === "uri" ? n.image !== o.image : yield* buildChanged(n, output)) {
            return { action: "replace" } as const;
          }
        }),

        lookup: Effect.fn(function* ({ runtime, name }) {
          const version = yield* getVersion(runtime, name);
          if (version === undefined) return undefined;
          const parent = yield* lambdacore.getRuntime({ RuntimeName: runtime });
          return toAttrs(
            version,
            { runtimeArn: parent.Arn, runtimeName: parent.Name },
            {
              source: "uri",
              hash: version.ResolvedUri,
              repositoryName: "",
              ownsRepository: false,
            },
          );
        }),

        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const version = yield* getVersion(output.runtimeArn, output.versionName);
          if (version === undefined || version.State === "PENDING_DELETION") return undefined;
          return toAttrs(version, output, output.image);
        }),

        list: () =>
          lambdacore.listRuntimes.items({}).pipe(
            Stream.filter((runtime) => runtime.State !== "PENDING_DELETION"),
            Stream.flatMap(
              (runtime) =>
                lambdacore.listRuntimeVersions.items({ RuntimeName: runtime.Arn }).pipe(
                  Stream.filter((version) => version.State !== "PENDING_DELETION"),
                  Stream.mapEffect((summary) => getVersion(runtime.Arn, summary.Name)),
                  Stream.flatMap((version) =>
                    version === undefined
                      ? Stream.empty
                      : Stream.make(
                          toAttrs(
                            version,
                            { runtimeArn: runtime.Arn, runtimeName: runtime.Name },
                            {
                              source: "uri",
                              hash: version.ResolvedUri,
                              repositoryName: "",
                              ownsRepository: false,
                            },
                          ),
                        ),
                  ),
                ),
              { concurrency: 5 },
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          ),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const n = resolved(news);
          const runtime = { runtimeArn: n.runtime.runtimeArn, runtimeName: n.runtime.runtimeName };
          const name = output?.versionName ?? (yield* resolveVersionName(id, n.name));

          // The image: build it into a managed repository, or resolve the
          // given URI to a digest.
          const image = yield* functionImage.resolve({
            id,
            source: imageSourceOf(n),
            architecture: architectureOf(n),
            consumer: "runtime",
            previousImage:
              output?.image.ownsRepository === true
                ? {
                    source: output.image.source,
                    imageUri: output.resolvedUri,
                    resolvedImageUri: output.resolvedUri,
                    digest: "",
                    repositoryName: output.image.repositoryName,
                    repositoryUri: output.resolvedUri.split("@")[0],
                    ownsRepository: true,
                  }
                : undefined,
            session,
          });
          const imageAttrs = {
            source: image.source,
            hash: image.hash,
            repositoryName: image.repositoryName,
            ownsRepository: image.ownsRepository,
          };

          // Observe. A version pending deletion keeps its name reserved;
          // restore it when it was made from the same image.
          let version = yield* getVersion(runtime.runtimeArn, name);
          if (version?.State === "PENDING_DELETION") {
            if (version.ResolvedUri !== image.resolvedImageUri) {
              return yield* new RuntimeVersionNameReserved({
                message: `Runtime version ${name} is pending deletion until ${version.PendingDeletionAt} with a different image (${version.ResolvedUri}); its name is reserved until then.`,
              });
            }
            yield* session.note(`Restoring runtime version ${name} from pending deletion...`);
            yield* lambdacore.restoreRuntime({
              RuntimeName: runtime.runtimeArn,
              RuntimeVersion: name,
            });
            version = yield* getVersion(runtime.runtimeArn, name);
          }

          // Ensure.
          if (version === undefined) {
            yield* session.note(
              `Creating runtime version ${name} from ${image.resolvedImageUri}...`,
            );
            yield* lambdacore
              .createRuntimeVersion({
                RuntimeName: runtime.runtimeArn,
                Name: name,
                ImageUri: image.resolvedImageUri,
                ReleaseNotes: n.releaseNotes,
              })
              .pipe(Effect.catchTag("ResourceConflictException", () => Effect.void));
          }
          version = yield* waitForActive(runtime.runtimeArn, name, session);

          // Sync the release notes, the one mutable field.
          if ((version.ReleaseNotes || undefined) !== n.releaseNotes) {
            yield* lambdacore.updateRuntimeVersion({
              RuntimeName: runtime.runtimeArn,
              Name: name,
              ReleaseNotes: n.releaseNotes ?? "",
            });
            version = yield* waitForActive(runtime.runtimeArn, name, session);
          }

          return toAttrs(version, runtime, imageAttrs);
        }),

        delete: Effect.fn(function* ({ olds, output, session, force }) {
          yield* session.note(`Scheduling runtime version ${output.versionName} for deletion...`);
          yield* lambdacore
            .deleteRuntimeVersion({
              RuntimeName: output.runtimeArn,
              Name: output.versionName,
              RecoveryWindowInDays: recoveryWindowOf(olds.recoveryWindowInDays, force),
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // An alias moving off this version may still be UPDATING.
              Effect.retry({
                while: (e) => e._tag === "ResourceConflictException",
                schedule: Schedule.spaced("3 seconds"),
                times: 10,
              }),
            );
          if (output.image.ownsRepository) {
            yield* functionImage.deleteRepository(output.image.repositoryName);
          }
        }),
      };

      function buildChanged(n: ResolvedProps, output: RuntimeVersion["Attributes"]) {
        return functionImage
          .hash("RuntimeVersion", imageSourceOf(n), architectureOf(n))
          .pipe(Effect.map((hash) => hash !== output.image.hash));
      }
    }),
  );
