import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Unowned } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { getStableContextDir } from "../../Bundle/TempRoot.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { hashDockerBuildInputs } from "../../Docker/BuildHash.ts";
import { Docker } from "../../Docker/Docker.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import { repositoryFromImageRef } from "../../Docker/Registry.ts";
import * as Provider from "../../Provider.ts";
import type { ScopedPlanStatusSession } from "../../Report.ts";
import { type ResourceBinding } from "../../Resource.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { isLiveId } from "../LocalRuntime.ts";
import { CloudflareLogs, type TelemetryFilter } from "../Logs.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
  DevContainerImage,
  DurableObjectContainerProps,
} from "./ContainerApplication.ts";
import {
  buildFinalDockerfile,
  withImageLayers,
  bundleContainerProgram,
  containerEnvPreamble,
  createContainerApplicationName,
  makeContainerEnv,
  materializeInlineDockerfileContext,
  validateContainerImageProps,
} from "./ContainerBundle.ts";
import {
  ContainerConfigurationError,
  isDurableObjectContainer,
  durableObjectPlaceholder,
  namedImageHash,
  durableObjectSettingsPatch,
  validateContainerConfiguration,
} from "./ContainerConfiguration.ts";
import { waitForContainerImage } from "./ContainerImagePreparation.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";
import { retryContainerPublication } from "./ContainerPublication.ts";

/**
 * The image source resolved from a {@link ContainerApplicationProps}. Selects
 * one of three strategies used by `buildAndPushImage`:
 *
 * - `effectful` — bundle an Effect-native `main` and build a generated image.
 * - `external` — build a user-supplied Dockerfile against a context directory.
 * - `remote` — pull a pre-built remote image and re-push it to Cloudflare.
 * - `prepushed` — the image already lives in the target registry; use the
 *   reference as-is with no docker pull/build/push at all.
 */
type ImageBuild =
  | {
      readonly kind: "effectful";
      readonly files: ReadonlyArray<{ path: string; content: Uint8Array }>;
    }
  | {
      readonly kind: "external";
      readonly context: string;
      readonly dockerfile: string;
    }
  | {
      readonly kind: "remote";
      readonly image: string;
    }
  | {
      readonly kind: "prepushed";
      readonly image: string;
    };

/**
 * Whether an image reference already points at the target registry host —
 * e.g. `registry.cloudflare.com/<accountId>/repo@sha256:...` pushed by CI.
 * Such references are deployed as-is; there is nothing to pull or push.
 */
const isTargetRegistryRef = (image: string, registryId: string) =>
  image.startsWith(`${registryId}/`);

/**
 * Insert the account namespace into a Cloudflare-registry reference that
 * omits it (`registry.cloudflare.com/app:tag` →
 * `registry.cloudflare.com/<accountId>/app:tag`), mirroring wrangler's
 * `resolveImageName`. Custom registries are left untouched — the account
 * namespace rule is specific to Cloudflare's managed registry.
 */
const normalizePrepushedRef = (image: string, registryId: string, accountId: string) => {
  if (registryId !== "registry.cloudflare.com") return image;
  const rest = image.slice(registryId.length + 1);
  const first = rest.split("/")[0];
  return first !== undefined && /^[a-f0-9]{32}$/.test(first)
    ? image
    : `${registryId}/${accountId}/${rest}`;
};

const RegistryDigest = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-z0-9]+:[a-f0-9]{64}$/i)),
);
const isRegistryDigest = Schema.is(RegistryDigest);

class ContainerRegistryError extends Schema.TaggedError<ContainerRegistryError>()(
  "ContainerRegistryError",
  {
    reason: Schema.Literals([
      "CredentialsMissingUsername",
      "ImageOutsideRegistry",
      "InvalidImageReference",
      "ImageNotFound",
      "ManifestRequestFailed",
      "InvalidManifestDigest",
    ]),
    message: Schema.String,
    imageRef: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect({ includeStack: true })),
  },
) {}

const digestFromImageRef = (imageRef: string) => {
  const separator = imageRef.lastIndexOf("@");
  if (separator === -1) return undefined;
  const digest = imageRef.slice(separator + 1);
  return isRegistryDigest(digest) ? digest : undefined;
};

export const LiveContainerProvider = () =>
  Provider.effect(
    ContainerPlatform,
    Effect.gen(function* () {
      const { dotAlchemy } = yield* AlchemyContext;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const http = yield* HttpClient.HttpClient;

      const telemetry = yield* CloudflareLogs;

      const createApplicationName = createContainerApplicationName;

      const findApplicationByName = Effect.fn(function* (name: string) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) => apps.find((app) => app.name === name)),
        );
      });

      const findApplicationByNamespace = Effect.fn(function* (namespaceId: string) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) => apps.find((app) => app.durableObjects?.namespaceId === namespaceId)),
        );
      });

      // After deleting an application by id, Cloudflare's account-scoped
      // `list` endpoint stays eventually-consistent for a short window and can
      // keep returning the now-deleted row. A subsequent recreate that
      // re-discovers the application by name (`createApplication`) would then
      // "adopt" that stale row and try to UPDATE it — which fails permanently
      // with `ContainerApplicationNotFound` (the app is really gone) and
      // exhausts the readiness retry. Block until the deleted id no longer
      // appears under that name (or a different id has taken the name, i.e. a
      // concurrent recreate) before proceeding. Bounded by the readiness
      // schedule; if it never clears we fall through and let create handle it.
      const waitForApplicationDeleted = (name: string, deletedId: string) =>
        findApplicationByName(name).pipe(
          Effect.repeat({
            schedule: containerApplicationReadinessSchedule,
            until: (app) => app?.id !== deletedId,
          }),
          Effect.asVoid,
        );

      const desiredConfiguration = (
        props: AnyContainerApplicationProps,
        env: Record<string, string | Redacted.Redacted<string>>,
        imageRef: string,
      ) =>
        normalizeNulls({
          image: imageRef,
          // Default to wrangler's instance type ("lite") so containers schedule
          // the same way out of the box. `instance_type` is mutually exclusive
          // with explicit vcpu/memory/disk, so only default it when none are
          // set. ("dev" is wrangler's deprecated alias for "lite".)
          instanceType:
            props.instanceType ??
            (props.vcpu === undefined &&
            props.memory === undefined &&
            props.memoryMib === undefined &&
            props.disk === undefined
              ? "lite"
              : undefined),
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          memoryMib: props.memoryMib,
          disk: props.disk,
          environmentVariables: Object.entries(env).map(([name, value]) => ({
            name,
            value: Redacted.isRedacted(value) ? Redacted.value(value) : value,
          })),
          labels: props.labels,
          network: props.network,
          command: props.command,
          entrypoint: props.entrypoint,
          dns: props.dns,
          ports: props.ports,
          checks: props.checks,
        }) as ContainerApplication.Configuration;

      // Scaling/placement defaults mirror wrangler's container defaults
      // (`wrangler-dist/cli.js`) so an Alchemy container behaves like a
      // `wrangler deploy`d one without extra config:
      //   - max_instances: 20            (`container.max_instances ?? 20`)
      //   - instances: 0                 (wrangler forces 0 whenever
      //                                    max_instances is set, which we always
      //                                    do — pure scale-from-zero)
      //   - scheduling_policy: "default"
      // (wrangler also defaults `constraints.tiers` to `[1, 2]`, but the
      // distilled SDK models constraints as singular `tier`, not the `tiers`
      // array, so we leave constraints untouched — it's a minor placement hint
      // next to the scaling defaults.)
      // A maxInstances default of 1 (the previous value) silently serialised
      // every Durable Object instance through a single container slot, which is
      // the dominant cause of "containers are slow under load".
      const scalingDefaults = (props: AnyContainerApplicationProps) => ({
        instances: props.instances ?? 0,
        maxInstances: props.maxInstances ?? 20,
        schedulingPolicy: props.schedulingPolicy ?? "default",
        constraints: props.constraints ?? {},
      });

      const applicationConfigurationHash = Effect.fn("applicationConfigurationHash")(function* (
        scaling: ReturnType<typeof scalingDefaults>,
        affinities: ContainerApplication.Affinities | undefined,
        configuration: ContainerApplication.Configuration,
      ) {
        return yield* sha256Object({
          scaling,
          affinities: normalizeNulls(affinities),
          configuration,
        });
      });

      const registryCredentials = Effect.fn("registryCredentials")(function* (
        props: AnyContainerApplicationProps,
        permissions: Array<"pull" | "push">,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const registryId = props.registryId ?? "registry.cloudflare.com";
        const credentials = yield* Containers.createContainerRegistryCredentials({
          accountId,
          registryId,
          permissions,
          expirationMinutes: 60,
        });
        const username = credentials.username ?? credentials.user;
        if (!username) {
          return yield* ContainerRegistryError.make({
            reason: "CredentialsMissingUsername",
            message: `Cloudflare registry ${registryId} did not return a username`,
          });
        }
        return {
          server: registryId,
          username,
          password: credentials.password,
        };
      });

      const resolveRegistryDigest = Effect.fn("resolveRegistryDigest")(function* (
        imageRef: string,
        credentials: {
          server: string;
          username: string;
          password: string | Redacted.Redacted<string>;
        },
      ) {
        const embeddedDigest = digestFromImageRef(imageRef);
        if (embeddedDigest !== undefined) return embeddedDigest;

        const registryHost = credentials.server.replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (!imageRef.startsWith(`${registryHost}/`)) {
          return yield* ContainerRegistryError.make({
            reason: "ImageOutsideRegistry",
            message: `Cannot resolve an image outside registry ${registryHost}`,
            imageRef,
          });
        }
        const repositoryAndTag = imageRef.slice(registryHost.length + 1);
        const tagSeparator = repositoryAndTag.lastIndexOf(":");
        if (tagSeparator <= repositoryAndTag.lastIndexOf("/")) {
          return yield* ContainerRegistryError.make({
            reason: "InvalidImageReference",
            message: "Container image reference has no tag or digest",
            imageRef,
          });
        }
        const repository = repositoryAndTag.slice(0, tagSeparator);
        const tag = repositoryAndTag.slice(tagSeparator + 1);
        const manifestUrl = `https://${registryHost}/v2/${repository
          .split("/")
          .map(encodeURIComponent)
          .join("/")}/manifests/${encodeURIComponent(tag)}`;
        const request = HttpClientRequest.head(manifestUrl).pipe(
          HttpClientRequest.basicAuth(credentials.username, credentials.password),
          HttpClientRequest.setHeader(
            "Accept",
            "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json",
          ),
        );
        const response = yield* http.execute(request).pipe(
          Effect.mapError(() =>
            ContainerRegistryError.make({
              reason: "ManifestRequestFailed",
              message: "Failed to resolve the container registry digest",
              imageRef,
            }),
          ),
        );
        if (response.status === 404) {
          return yield* ContainerRegistryError.make({
            reason: "ImageNotFound",
            message: "Container image is not published",
            imageRef,
          });
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* ContainerRegistryError.make({
            reason: "ManifestRequestFailed",
            message: `Container registry returned HTTP ${response.status}`,
            imageRef,
          });
        }
        return yield* Schema.decodeUnknownEffect(RegistryDigest)(
          response.headers["docker-content-digest"],
        ).pipe(
          Effect.mapError((cause) =>
            ContainerRegistryError.make({
              reason: "InvalidManifestDigest",
              message: "Registry response did not include a valid digest",
              imageRef,
              cause,
            }),
          ),
        );
      });

      const resolvePublishedImageRef = Effect.fn("resolvePublishedImageRef")(function* (
        props: AnyContainerApplicationProps,
        imageRef: string,
      ) {
        let digest = digestFromImageRef(imageRef);
        if (digest === undefined) {
          const credentials = yield* registryCredentials(props, ["pull"]);
          digest = yield* resolveRegistryDigest(imageRef, credentials);
        }
        return {
          imageRef: `${repositoryFromImageRef(imageRef)}@${digest}`,
          digest,
        };
      });

      const computeImage = Effect.fn(function* (
        id: string,
        props: AnyContainerApplicationProps,
        env: Record<string, string | Redacted.Redacted<string>>,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const name = yield* createApplicationName(id, props.name);
        const registryId = props.registryId ?? "registry.cloudflare.com";
        const repositoryName = (props.publish?.repository ?? name).toLowerCase();
        const makeRef = (imageHash: string) =>
          `${registryId}/${accountId}/${repositoryName}:${imageHash}`;

        yield* validateContainerImageProps(props);

        // Preserve serialized imageName keys so existing publication hashes remain valid.
        // Variant 1 — Effect-native program. Bundle `main` and build a
        // generated Dockerfile around it; the environment preamble comes
        // from `image` / inline `dockerfile` (default: the runtime base).
        if (props.main) {
          const runtime = props.runtime ?? "bun";
          const { files, hash: bundleHash } = yield* bundleContainerProgram({
            id,
            main: props.main,
            runtime,
            handler: props.handler,
            isExternal: props.isExternal,
            external: props.external,
            build: props.build,
          });
          const finalDockerfile = buildFinalDockerfile(
            yield* containerEnvPreamble(props),
            runtime,
            props.external,
            props.autoInstallExternals,
          );
          const imageHash = (yield* sha256Object({
            bundleHash,
            dockerfile: finalDockerfile,
            imageName: props.publish?.repository?.toLowerCase(),
          })).slice(0, 16);
          // The dev image is the deterministic build-context directory that
          // `buildAndPushImage` materializes into (and that the local provider
          // regenerates on the next `alchemy dev`). We persist the path here so
          // a dev run after a live deploy has an image to `docker build` — the
          // live deploy pushes to Cloudflare's registry, which the local
          // `workerd` runtime can't pull. See `prepareContainerBuildContext`.
          const contextDir = yield* getStableContextDir(
            process.cwd(),
            dotAlchemy,
            `${id}-container`,
          );
          return {
            build: { kind: "effectful" as const, files },
            imageRef: makeRef(imageHash),
            imageHash,
            dev: {
              context: path.relative(process.cwd(), contextDir),
              dockerfile: "Dockerfile",
              env,
            },
          };
        }

        // Variant 2 — pre-built remote image. The image reference is the
        // identity; we pull and re-push it without building anything.
        if (props.image) {
          const imageHash = (yield* sha256Object({
            image: props.image,
            imageName: props.publish?.repository?.toLowerCase(),
          })).slice(0, 16);
          // Already in the target registry (e.g. pushed by CI as a digest
          // reference) — deploy the reference as-is and skip the docker
          // pull/tag/push round-trip entirely.
          if (isTargetRegistryRef(props.image, registryId)) {
            const prepushedRef = normalizePrepushedRef(props.image, registryId, accountId);
            return {
              build: { kind: "prepushed" as const, image: prepushedRef },
              imageRef: prepushedRef,
              imageHash,
              // The local runtime pulls this image directly (no build
              // context); pulling from the Cloudflare registry requires a
              // local `docker login`.
              dev: { imageUri: prepushedRef, env },
            };
          }
          return {
            build: { kind: "remote" as const, image: props.image },
            imageRef: makeRef(imageHash),
            imageHash,
            // The local runtime pulls this image directly (no build context).
            dev: { imageUri: props.image, env },
          };
        }

        // Variant 3a — inline Dockerfile content (`Dockerfile.inline`), no
        // build context. Materialize the content into a stable generated
        // context directory and build that.
        if (props.dockerfile !== undefined && isInlineDockerfile(props.dockerfile)) {
          const content = props.dockerfile.content;
          if (typeof content !== "string") {
            return yield* Effect.die(
              new Error(
                "Inline `dockerfile` content is an unresolved Output at image-build time — its dependencies have not resolved yet (e.g. during precreate of a circular binding). Break the cycle or inline the resolved value.",
              ),
            );
          }
          const { context, dockerfile } = yield* materializeInlineDockerfileContext(id, content);
          const imageHash = (yield* sha256Object({
            dockerfile: content,
            imageName: props.publish?.repository?.toLowerCase(),
          })).slice(0, 16);
          return {
            build: { kind: "external" as const, context, dockerfile },
            imageRef: makeRef(imageHash),
            imageHash,
            // The local runtime builds the same materialized context.
            dev: {
              context: path.relative(process.cwd(), context),
              dockerfile: "Dockerfile",
              env,
            },
          };
        }

        // Variant 3b — user-supplied Dockerfile path + build context
        // directory.
        const context = yield* fs.realPath(props.context ?? ".");
        const dockerfile = props.dockerfile
          ? yield* fs.realPath(props.dockerfile)
          : path.join(context, "Dockerfile");
        // Hash what Docker can consume, including gitignored files and file
        // modes, but excluding ancestor lockfiles outside the build context.
        const contextHash = yield* hashDockerBuildInputs(
          { context, dockerfile, platform: publicationPlatform },
          "effective",
        );
        const imageHash = (yield* sha256Object({
          contextHash,
          imageName: props.publish?.repository?.toLowerCase(),
        })).slice(0, 16);
        return {
          build: { kind: "external" as const, context, dockerfile },
          imageRef: makeRef(imageHash),
          imageHash,
          // The local runtime builds the user's Dockerfile against the same
          // (already real-path'd) context directory.
          dev: {
            context: path.relative(process.cwd(), context),
            dockerfile: path.relative(context, dockerfile),
            env,
          },
        };
      });

      const publicationPlatform = "linux/amd64";
      const publishImage = Effect.fn("publishImage")(function* (
        id: string,
        props: AnyContainerApplicationProps,
        build: ImageBuild,
        imageRef: string,
        // The full session, not just `note`: `Docker.image.build` streams the
        // builder's output through it as `kind: "output"` notes.
        session?: ScopedPlanStatusSession,
        reuseRemotePublication = false,
      ) {
        const platform = publicationPlatform;

        if (build.kind === "prepushed") {
          // The reference already lives in the target registry — nothing to
          // pull, build, or push.
          yield* Effect.logInfo(`Cloudflare Container image: using pre-pushed ${imageRef}`);
          return yield* resolvePublishedImageRef(props, imageRef);
        }

        const credentials = yield* registryCredentials(props, ["pull", "push"]);

        if (build.kind !== "remote" || reuseRemotePublication) {
          const digest = yield* resolveRegistryDigest(imageRef, credentials).pipe(
            Effect.catchTag("ContainerRegistryError", (error) =>
              error.reason === "ImageNotFound" ? Effect.succeed(undefined) : Effect.fail(error),
            ),
          );
          if (digest !== undefined) {
            const published = `${repositoryFromImageRef(imageRef)}@${digest}`;
            yield* Effect.logInfo(`Cloudflare Container image: registry cache hit ${published}`);
            if (session) {
              yield* session.note(`Reusing registry container image ${published}.`);
            }
            return { imageRef: published, digest };
          }
        }
        const cacheRef = `${repositoryFromImageRef(imageRef)}:buildcache`;
        const cacheOptions = {
          "cache-from": [`type=registry,ref=${cacheRef}`],
          "cache-to": ["type=inline"],
        };

        if (build.kind === "remote") {
          // Pull the pre-built image and re-tag it to the Cloudflare registry
          // reference; nothing is built locally.
          yield* Effect.logInfo(`Cloudflare Container image: pulling ${build.image}`);
          if (session) {
            yield* session.note(`Pulling container image ${build.image}...`);
          }
          yield* docker.image.pull(build.image, platform, undefined, session);
          yield* docker.image.tag(build.image, imageRef);
          yield* Effect.logInfo(`Cloudflare Container image: pushing ${imageRef}`);
          if (session) {
            yield* session.note(`Pushing container image ${imageRef}...`);
          }
          // Push the same platform that was pulled. A containerd image store
          // may also hold a host-architecture variant under this tag.
          yield* docker.image
            .push(imageRef, credentials, platform, undefined, session)
            .pipe(retryContainerPublication);
        } else if (build.kind === "external") {
          // Build the user's Dockerfile directly against their context dir so
          // relative `COPY`/`ADD` paths resolve as the author intended.
          yield* Effect.logInfo(`Cloudflare Container image: building ${imageRef}`);
          if (session) {
            yield* session.note(`Building container image ${imageRef}...`);
          }
          yield* docker.image
            .build(
              {
                ...cacheOptions,
                tag: [imageRef, cacheRef],
                context: build.context,
                platform,
                file: build.dockerfile,
              },
              session,
              credentials,
            )
            .pipe(retryContainerPublication);
        } else {
          // Effect-native program: materialize the generated Dockerfile and
          // bundled chunks into a stable staging dir, then build.
          yield* Effect.logInfo(`Cloudflare Container image: building ${imageRef}`);
          if (session) {
            yield* session.note(`Building container image ${imageRef}...`);
          }
          const runtime = props.runtime ?? "bun";
          const contextDir = yield* getStableContextDir(
            process.cwd(),
            dotAlchemy,
            `${id}-container`,
          );
          const finalDockerfile = buildFinalDockerfile(
            yield* containerEnvPreamble(props),
            runtime,
            props.external,
            props.autoInstallExternals,
          );
          yield* docker.materialize({
            context: contextDir,
            dockerfile: finalDockerfile,
            files: build.files.map((f, i) => ({
              path: i === 0 ? "index.mjs" : f.path,
              content: f.content,
            })),
          });
          yield* docker.image
            .build(
              {
                ...cacheOptions,
                tag: [imageRef, cacheRef],
                context: contextDir,
                platform,
              },
              session,
              credentials,
            )
            .pipe(retryContainerPublication);
        }

        // Resolve the pushed manifest digest from the registry itself rather
        // than scraping `docker push` output: one mechanism for every image
        // source (local build, remote re-push, pre-pushed tag), and the
        // registry is authoritative for what the application will pull.
        const digest = yield* resolveRegistryDigest(imageRef, credentials);
        return {
          imageRef: `${repositoryFromImageRef(imageRef)}@${digest}`,
          digest,
        };
      });

      // Applications with identical image inputs can share one immutable
      // registry reference. Keep publication state within this provider instance.
      const publications = new Map<string, ReturnType<typeof publishImage>>();
      const buildAndPushImage = Effect.fn("buildAndPushImage")(function* (
        id: string,
        props: AnyContainerApplicationProps,
        build: ImageBuild,
        imageRef: string,
        imageHash: string,
        previousImageRef: string | undefined,
        session?: ScopedPlanStatusSession,
        reuseRemotePublication = false,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const key = JSON.stringify([
          accountId,
          props.registryId ?? "registry.cloudflare.com",
          props.publish?.repository,
          publicationPlatform,
          build.kind,
          reuseRemotePublication,
          imageHash,
        ]);
        const candidate: ReturnType<typeof publishImage> = yield* Effect.cached(
          publishImage(id, props, build, imageRef, session, reuseRemotePublication).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.sync(() => {
                    // A failed or interrupted publisher must not poison a
                    // later attempt, or remove an entry that replaced it.
                    if (publications.get(key) === candidate) {
                      publications.delete(key);
                    }
                  })
                : Effect.void,
            ),
          ),
        );
        const publication = yield* Effect.sync(() => {
          // Allocate atomically: concurrent callers execute only the winning
          // candidate, sharing both its in-flight work and successful result.
          const existing = publications.get(key);
          if (existing) return existing;
          publications.set(key, candidate);
          return candidate;
        });
        const published = yield* publication;
        return {
          ...published,
          // Previous image identity belongs to each application, not the
          // shared image publication. Resolve it separately for every caller.
          previousDigest:
            previousImageRef === undefined
              ? undefined
              : (yield* resolvePublishedImageRef(props, previousImageRef)).digest,
        };
      });

      const resolveDeploymentImage = Effect.fn(function* ({
        id,
        news,
        existing,
        build,
        imageRef,
        imageHash,
        session,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        existing: ContainerApplication["Attributes"];
        build: ImageBuild;
        imageRef: string;
        imageHash: string;
        session: ScopedPlanStatusSession;
      }) {
        yield* validateContainerConfiguration(news, existing.schedulingPolicy);
        const existingImage = existing.configuration.image;
        if (!existingImage) {
          return yield* new ContainerConfigurationError({
            message: `Container application '${existing.applicationName}' has no deployment image.`,
          });
        }
        let deploymentImageRef = existingImage;
        let imageDigest = existing.hash?.digest;
        if (imageHash !== existing.hash?.image) {
          const published = yield* buildAndPushImage(
            id,
            news,
            build,
            imageRef,
            imageHash,
            existing.hash?.digest === undefined ? existingImage : undefined,
            session,
          );
          const existingDigest = existing.hash?.digest ?? published.previousDigest;
          deploymentImageRef =
            published.digest === existingDigest && news.publish?.repository === undefined
              ? existingImage
              : published.imageRef;
          imageDigest = published.digest;
        }
        return { deploymentImageRef, imageDigest };
      });

      // ---------------------------------------------------------------
      // Durable Object-managed applications (schedulingPolicy:
      // "durable_object"). These have no deployment image or rollout: the
      // Durable Object picks one of the named `images` at `start()` time.
      // ---------------------------------------------------------------

      /** Resolve the build inputs and content hash of every named image. */
      const computeNamedImages = Effect.fn(function* (
        id: string,
        props: DurableObjectContainerProps,
      ) {
        return yield* Effect.forEach(
          Object.entries(props.images ?? {}),
          Effect.fn(function* ([name, source]) {
            const imageId = `${id}-${name}`;
            const image = yield* computeImage(imageId, source, {});
            return { name, imageId, source, ...image };
          }),
        );
      });

      const hashesByName = (images: { name: string; imageHash: string }[]) =>
        Object.fromEntries(images.map((image) => [image.name, image.imageHash]));

      /**
       * Cloudflare must prepare an image before a Worker upload may reference
       * it. Preparation is per image reference, so remember the ones that are
       * already done for the lifetime of this provider.
       */
      const preparedImages = new Set<string>();
      const waitForImagePrepared = Effect.fn(function* (
        image: string,
        name: string,
        timeout: DurableObjectContainerProps["imagePreparationTimeout"],
        session: ScopedPlanStatusSession,
      ) {
        if (preparedImages.has(image)) return;
        const { accountId } = yield* yield* CloudflareEnvironment;
        yield* waitForContainerImage({
          image,
          name,
          timeout,
          session,
          prepare: Containers.prepareContainerImage({ accountId, image }),
        });
        preparedImages.add(image);
      });

      /**
       * Publish every named image to Cloudflare's registry and wait until each
       * one is prepared. An image whose content hash is unchanged keeps its
       * previously published reference.
       */
      const publishNamedImages = Effect.fn(function* (
        id: string,
        props: DurableObjectContainerProps,
        output: ContainerApplication["Attributes"] | undefined,
        session: ScopedPlanStatusSession,
      ) {
        const images: Record<string, string> = {};
        const devImages: Record<string, DevContainerImage> = {};
        const hashes: Record<string, string> = {};

        for (const image of yield* computeNamedImages(id, props)) {
          const previousRef = output?.images?.[image.name];
          const unchanged = output?.hash?.images?.[image.name] === image.imageHash;

          let imageRef: string;
          if (previousRef !== undefined && unchanged) {
            imageRef = previousRef;
          } else {
            const published = yield* buildAndPushImage(
              image.imageId,
              image.source,
              image.build,
              image.imageRef,
              image.imageHash,
              undefined,
              session,
              // The registry tag keyed by image inputs is the durable publication checkpoint.
              // Reuse it after an interrupted preparation, including mirrored images.
              true,
            );
            imageRef = published.imageRef;
          }
          yield* waitForImagePrepared(imageRef, image.name, props.imagePreparationTimeout, session);

          images[image.name] = imageRef;
          devImages[image.name] = image.dev;
          hashes[image.name] = image.imageHash;
        }

        return {
          images,
          devImages,
          hash: yield* namedImageHash(hashes),
        };
      });

      const diffDurableObjectApplication = Effect.fn(function* ({
        id,
        news,
        name,
        oldName,
        accountId,
        output,
        newBindings,
      }: {
        id: string;
        news: DurableObjectContainerProps;
        name: string;
        oldName: string;
        accountId: string;
        output: ContainerApplication["Attributes"] | undefined;
        newBindings: ResourceBinding<ContainerApplication["Binding"]>[];
      }) {
        // A namespace holds exactly one application, so a replacement could
        // never be created next to the old one. Refuse instead.
        const movedAccount =
          output !== undefined && output.accountId !== accountId && isLiveId(output.applicationId);
        if (name !== oldName || movedAccount) {
          return yield* new ContainerConfigurationError({
            message:
              "A Durable Object-managed container cannot change its application name or account in place. Declare a new application and Durable Object namespace.",
          });
        }
        const deployedNamespace = output?.durableObjects?.namespaceId;
        const namespace = yield* getDurableObjects(newBindings);
        if (
          deployedNamespace !== undefined &&
          namespace !== undefined &&
          deployedNamespace !== namespace.namespaceId
        ) {
          return yield* new ContainerConfigurationError({
            message:
              "A container application cannot move to a different Durable Object namespace. Declare a new application for the new namespace.",
          });
        }

        // Precreate only reserves a name; reconcile creates the application
        // once the Worker has created its namespace.
        if (!output?.applicationId || !isLiveId(output.applicationId)) {
          return { action: "update" as const, stables: ["accountId"] };
        }

        // Image content (a Dockerfile, a context file) can change without any
        // prop changing, so compare content hashes as well.
        const hashes = hashesByName(yield* computeNamedImages(id, news));
        if (output.images === undefined || !deepEqual(hashes, output.hash?.images)) {
          return { action: "update" } as const;
        }
        return undefined;
      });

      const reconcileDurableObjectApplication = Effect.fn(function* ({
        id,
        news,
        olds,
        name,
        durableObjects,
        output,
        session,
      }: {
        id: string;
        news: DurableObjectContainerProps;
        olds: AnyContainerApplicationProps | undefined;
        name: string;
        durableObjects: { namespaceId: string } | undefined;
        output: ContainerApplication["Attributes"] | undefined;
        session: ScopedPlanStatusSession;
      }) {
        if (!durableObjects) {
          return yield* new ContainerConfigurationError({
            message: `Container application '${name}' requires a resolved Durable Object namespace. Reconcile its Worker first.`,
          });
        }
        const { accountId } = yield* yield* CloudflareEnvironment;
        // The application's id is the id of the namespace it serves.
        const applicationId = durableObjects.namespaceId;
        const getApplication = Containers.getContainerApplication({
          accountId,
          applicationId,
        });
        const assertMatchesDeclaration = (
          application: Containers.GetContainerApplicationResponse,
        ) => {
          const matches =
            application.id === applicationId &&
            application.name === name &&
            application.schedulingPolicy === "durable_object" &&
            application.durableObjects?.namespaceId === applicationId;
          if (matches) return Effect.void;
          return Effect.fail(
            new ContainerConfigurationError({
              message: `The application for Durable Object namespace '${applicationId}' does not match '${name}'. Its name, namespace, and scheduling policy must match before updating it.`,
            }),
          );
        };

        // 1. Observe
        let application = yield* getApplication.pipe(
          Effect.catchTag("ContainerApplicationNotFound", () => Effect.succeed(undefined)),
        );
        if (application) yield* assertMatchesDeclaration(application);

        // 2. Publish images. The Worker upload that follows references them.
        const published = yield* publishNamedImages(id, news, output, session);

        const configuration: Containers.DurableObjectContainerConfiguration = {
          ...(news.ssh !== undefined ? { wranglerSsh: news.ssh } : {}),
          ...(news.authorizedKeys !== undefined ? { authorizedKeys: news.authorizedKeys } : {}),
        };

        // 3. Ensure the application exists
        if (!application) {
          yield* session.note(`Creating container application ${name}...`);
          application = yield* retryNamespacePropagation(
            Containers.createDurableObjectContainerApplication({
              accountId,
              name,
              schedulingPolicy: "durable_object",
              durableObjects,
              configuration,
              observability: news.observability,
            }),
          ).pipe(Effect.catchTag("DurableObjectAlreadyHasApplication", () => getApplication));
          yield* assertMatchesDeclaration(application);
        }

        // 4. Sync declared settings and reset settings removed from prior props.
        const patch = durableObjectSettingsPatch(news, olds, application);
        if (patch.configuration !== undefined || patch.observability !== undefined) {
          application = yield* Containers.updateContainerApplication({
            accountId,
            applicationId,
            ...patch,
          });
        }

        return { ...toAttributes(application), ...published };
      });

      const maybeCreateRollout = Effect.fn(function* ({
        applicationId,
        configuration,
        rollout,
      }: {
        applicationId: string;
        configuration: ContainerApplication.Configuration;
        rollout: ContainerApplication.Rollout | undefined;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const strategy = rollout?.strategy ?? "immediate";
        const stepPercentage = strategy === "immediate" ? 100 : (rollout?.stepPercentage ?? 25);

        yield* retryForContainerApplicationReadiness(
          "rollout",
          applicationId,
          Containers.createContainerApplicationRollout({
            accountId,
            applicationId,
            description: strategy === "immediate" ? "Immediate update" : "Progressive update",
            strategy: "rolling",
            kind: rollout?.kind ?? "full_auto",
            stepPercentage,
            targetConfiguration: configuration,
          }),
        );
      });

      const createApplication = Effect.fn(function* ({
        id,
        news,
        bindings,
        name,
        configuration,
        durableObjects,
        session,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        bindings: ResourceBinding<ContainerApplication["Binding"]>[];
        name: string;
        configuration: ContainerApplication.Configuration;
        durableObjects:
          | {
              namespaceId: string;
            }
          | undefined;
        session: ScopedPlanStatusSession;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        const describeError = (error: unknown) => {
          if (error instanceof Error) {
            return JSON.stringify(
              Object.fromEntries(
                Object.getOwnPropertyNames(error).map((key) => [
                  key,
                  (error as unknown as Record<string, unknown>)[key],
                ]),
              ),
              null,
              2,
            );
          }
          return String(error);
        };

        // Engine has cleared us via `read` (foreign-named applications are
        // surfaced as `Unowned`). Re-fetch the existing application to fold
        // it into the upsert path.
        const existingByName = yield* findApplicationByName(name);

        if (existingByName) {
          yield* Effect.logInfo(
            `Cloudflare Container create: adopting existing application ${name}`,
          );
          return yield* upsertApplication({
            id,
            news,
            bindings,
            existing: toAttributes(existingByName),
            durableObjects,
            session,
          });
        }

        yield* Effect.logInfo(`Cloudflare Container create: creating application ${name}`);
        yield* session.note(`Creating container application ${name}...`);
        const adoptExistingByName = Effect.gen(function* () {
          yield* Effect.logInfo(
            `Cloudflare Container create: application ${name} already exists, adopting`,
          );
          const existing = yield* findApplicationByName(name);
          if (!existing) {
            return yield* Effect.fail(
              new Error(
                `Container application "${name}" already exists but could not be found for adoption.`,
              ),
            );
          }
          return yield* upsertApplication({
            id,
            news,
            bindings,
            existing: toAttributes(existing),
            durableObjects,
            session,
          });
        });

        const application = yield* retryNamespacePropagation(
          Containers.createContainerApplication({
            accountId,
            name,
            ...scalingDefaults(news),
            affinities: news.affinities,
            configuration,
            durableObjects,
          }),
        ).pipe(
          Effect.catchTag("DurableObjectAlreadyHasApplication", () =>
            durableObjects
              ? Effect.gen(function* () {
                  const existing = yield* findApplicationByNamespace(durableObjects.namespaceId);
                  const recovery = resolveDurableObjectApplicationRecovery({
                    namespaceId: durableObjects.namespaceId,
                    expectedName: name,
                    existingName: existing?.name,
                  });
                  if (!recovery.canAdopt) {
                    return yield* Effect.fail(new Error(recovery.message));
                  }
                  if (!existing) {
                    return yield* Effect.fail(
                      new Error(
                        `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                      ),
                    );
                  }
                  return yield* upsertApplication({
                    id,
                    news,
                    bindings,
                    existing: toAttributes(existing),
                    durableObjects,
                    session,
                  });
                })
              : Effect.fail(
                  new Error(
                    "Durable Object namespace already has a container application. Set AdoptPolicy to adopt it.",
                  ),
                ),
          ),
          Effect.catchIf(
            (e) => "message" in (e as any) && String((e as any).message).includes("already exists"),
            () => adoptExistingByName,
          ),
          Effect.tapError((error) =>
            Effect.logError(`Cloudflare Container create error: ${describeError(error)}`),
          ),
        );

        return "applicationId" in application ? application : toAttributes(application);
      });

      const upsertApplication = Effect.fn(function* ({
        id,
        news,
        bindings,
        existing,
        durableObjects,
        session,
      }: {
        id: string;
        news: AnyContainerApplicationProps;
        bindings: ResourceBinding<ContainerApplication["Binding"]>[];
        existing: ContainerApplication["Attributes"];
        // The DO attachment to (re)create with if the "existing" application
        // turns out to be gone. Threaded through so the update→create fallback
        // below preserves the binding.
        durableObjects: { namespaceId: string } | undefined;
        session: ScopedPlanStatusSession;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* Effect.logInfo(`Cloudflare Container update: preparing ${existing.applicationName}`);
        news = withImageLayers(news, bindings);
        const env = makeContainerEnv(news, accountId, bindings);
        const { build, imageRef, imageHash, dev } = yield* computeImage(id, news, env);
        const { deploymentImageRef, imageDigest } = yield* resolveDeploymentImage({
          id,
          news,
          existing,
          build,
          imageRef,
          imageHash,
          session,
        });
        const configuration = desiredConfiguration(news, env, deploymentImageRef);
        const scaling = scalingDefaults(news);
        const configurationHash = yield* applicationConfigurationHash(
          scaling,
          news.affinities,
          configuration,
        );
        if (existing.hash?.configuration === configurationHash) {
          yield* Effect.logInfo(
            `Cloudflare Container update: ${existing.applicationName} has no effective changes`,
          );
          yield* session.note(`Container application ${existing.applicationName} is unchanged.`);
          return {
            ...existing,
            configuration,
            hash: {
              image: imageHash,
              digest: imageDigest,
              configuration: configurationHash,
            },
            dev,
          };
        }

        yield* session.note(`Updating container application ${existing.applicationName}...`);
        const application = yield* retryForContainerApplicationReadiness(
          "update",
          existing.applicationId,
          Containers.updateContainerApplication({
            accountId,
            applicationId: existing.applicationId,
            ...scaling,
            affinities: news.affinities,
            configuration,
          }),
        ).pipe(
          // The "existing" application was observed from an eventually-
          // consistent list/get but is actually gone — e.g. a stale row that
          // lingered after a replacement/DO-recreate delete, surfaced by
          // either the by-name or by-namespace lookup. Updating a ghost
          // exhausts the readiness window and then fails permanently with
          // `ContainerApplicationNotFound`. Instead, create it fresh so
          // reconcile converges regardless of the stale observation. By the
          // time the bounded readiness retry has elapsed, the deleted row has
          // fallen out of the eventually-consistent views, so this create
          // does not re-collide.
          Effect.catchTag("ContainerApplicationNotFound", () =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Cloudflare Container update: ${existing.applicationName} no longer exists, creating fresh`,
              );
              return yield* retryNamespacePropagation(
                Containers.createContainerApplication({
                  accountId,
                  name: existing.applicationName,
                  ...scaling,
                  affinities: news.affinities,
                  configuration,
                  durableObjects,
                }),
              );
            }),
          ),
        );
        const updated = toAttributes(application);
        if (!deepEqual(existing.configuration, configuration)) {
          yield* Effect.logInfo(
            `Cloudflare Container update: creating rollout for ${updated.applicationName}`,
          );
          yield* maybeCreateRollout({
            applicationId: updated.applicationId,
            configuration,
            rollout: news.rollout,
          });
        }
        return {
          ...updated,
          configuration,
          hash: {
            image: imageHash,
            digest: imageDigest,
            configuration: configurationHash,
          },
          dev,
        };
      });

      const getDurableObjects = (bindings: ResourceBinding<ContainerApplication["Binding"]>[]) => {
        // A stale Worker namespace map can resolve a binding to an object
        // without an id. It does not request removing the live attachment.
        const dos = bindings.flatMap((b) =>
          b.data.durableObjects?.namespaceId ? [b.data.durableObjects] : [],
        );
        // A single DO namespace may appear in multiple bindings (e.g. when
        // a Container is referenced by several resources). Dedupe by namespaceId.
        const uniqueDos = dos.filter(
          (d, i, arr) => arr.findIndex((other) => other.namespaceId === d.namespaceId) === i,
        );
        if (uniqueDos.length === 0) {
          return Effect.succeed(undefined);
        }
        if (uniqueDos.length === 1) {
          return Effect.succeed(uniqueDos[0]);
        }
        return Effect.die(
          new Error(
            `A Container can only be bound to one Durable Object namespace. Found ${uniqueDos.length} unique namespaces in bindings: ${uniqueDos.map((d) => d.namespaceId).join(", ")}`,
          ),
        );
      };

      return ContainerPlatform.Provider.of({
        stables: ["accountId", "applicationId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output, newBindings, oldBindings }) {
          if (!isResolved(news)) return;
          yield* validateContainerConfiguration(news, output?.schedulingPolicy);
          if (!isResolved(newBindings)) return;
          const { accountId } = yield* yield* CloudflareEnvironment;

          const oldName = output?.applicationName ?? (yield* createApplicationName(id, olds.name));
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const name = news.name ?? oldName;

          if (isDurableObjectContainer(news)) {
            return yield* diffDurableObjectApplication({
              id,
              news,
              name,
              oldName,
              accountId,
              output,
              newBindings,
            });
          }

          if ((output?.accountId ?? accountId) !== accountId || name !== oldName) {
            return { action: "replace" } as const;
          }

          const hasDurableObjects = (yield* getDurableObjects(newBindings)) !== undefined;
          const hasUnresolvedAttachment =
            !hasDurableObjects &&
            newBindings.some((binding) => binding.data.durableObjects !== undefined);
          const hadDurableObjects = (yield* getDurableObjects(oldBindings)) !== undefined;
          if (!hasUnresolvedAttachment && hasDurableObjects !== hadDurableObjects) {
            return { action: "replace" } as const;
          }

          if (!output) {
            return undefined;
          }

          // A `dev:` applicationId means the resource only exists locally and
          // the real application has never been created. Promote it by forcing
          // an update so reconcile creates the live application.
          if (!isLiveId(output.applicationId)) {
            // Override stables to only include the accountId because the applicationId is going to change.
            return { action: "update", stables: ["accountId"] } as const;
          }

          const application = yield* Containers.getContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(Effect.catchTag("ContainerApplicationNotFound", () => Effect.succeed(undefined)));
          if (
            application &&
            (application.id !== output.applicationId ||
              application.name !== output.applicationName ||
              application.accountId !== output.accountId)
          ) {
            return { action: "replace" } as const;
          }

          const { imageHash, dev } = yield* computeImage(
            id,
            withImageLayers(news, newBindings),
            makeContainerEnv(news, accountId, newBindings),
          );
          if (imageHash !== output.hash?.image || !deepEqual(dev, output.dev)) {
            return { action: "update" } as const;
          }
        }),
        precreate: Effect.fn(function* ({ id, news = {}, session }) {
          yield* validateContainerConfiguration(news);
          const name = yield* createApplicationName(id, news.name);
          yield* Effect.logInfo(`Cloudflare Container precreate: starting ${name}`);

          const { accountId } = yield* yield* CloudflareEnvironment;
          if (isDurableObjectContainer(news)) {
            // The application needs the Worker's namespace id, which does not
            // exist yet; reconcile creates it. Publish the images now so the
            // Worker's first upload can already reference them.
            return {
              ...durableObjectPlaceholder({
                applicationId: "",
                applicationName: name,
                accountId,
                createdAt: "",
                observability: news.observability,
              }),
              ...(yield* publishNamedImages(id, news, undefined, session)),
            } satisfies ContainerApplication["Attributes"];
          }
          const env = makeContainerEnv(news, accountId);
          const { build, imageRef, imageHash, dev } = yield* computeImage(id, news, env);
          const published = yield* buildAndPushImage(
            id,
            news,
            build,
            imageRef,
            imageHash,
            undefined,
            session,
          );
          const configuration = desiredConfiguration(news, env, published.imageRef);
          const configurationHash = yield* applicationConfigurationHash(
            scalingDefaults(news),
            news.affinities,
            configuration,
          );

          // Precreate intentionally omits the Durable Object attachment so the
          // worker can bind to this application id and break the circular
          // dependency. The final create step recreates the application with the
          // resolved namespace when needed.
          const result = yield* createApplication({
            id,
            news,
            // Precreate runs before the engine resolves bindings (that is what
            // breaks the worker <-> container cycle), so binding-injected env
            // lands on the following reconcile.
            bindings: [],
            name,
            configuration,
            durableObjects: undefined,
            session: {
              ...session,
              note: (message) => session.note(message.replace("Creating", "Pre-creating")),
            },
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: {
              image: imageHash,
              digest: published.digest,
              configuration: configurationHash,
            },
            dev,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, olds, bindings, output, session }) {
          yield* validateContainerConfiguration(news, output?.schedulingPolicy);
          // Prefer the deployed name: regenerating would target a different
          // resource if the generator's output for this id ever drifts.
          const name = output?.applicationName ?? (yield* createApplicationName(id, news.name));
          yield* Effect.logInfo(`Cloudflare Container reconcile: starting ${name}`);
          const durableObjects = yield* getDurableObjects(bindings);
          if (isDurableObjectContainer(news)) {
            return yield* reconcileDurableObjectApplication({
              id,
              news,
              olds,
              name,
              durableObjects,
              output,
              session,
            });
          }
          const hasUnresolvedAttachment =
            durableObjects === undefined &&
            bindings.some((binding) => binding.data.durableObjects !== undefined);
          const { accountId } = yield* yield* CloudflareEnvironment;
          news = withImageLayers(news, bindings);
          const env = makeContainerEnv(news, accountId, bindings);

          // Observe — re-fetch the cached application to confirm it still
          // exists. Cloudflare reports a deleted container application as
          // `ContainerApplicationNotFound`; we fall back to a name lookup
          // so we can recover from out-of-band deletes or partial state
          // persistence failures.
          let existing: ContainerApplication["Attributes"] | undefined;
          // A `dev:` applicationId never exists on Cloudflare — skip the
          // cached-id fetch and fall through to the name lookup / create path
          // so we promote the local resource to a real application.
          if (output?.applicationId && isLiveId(output.applicationId)) {
            existing = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () => Effect.succeed(undefined)),
            );
          }
          if (!existing) {
            const found = yield* findApplicationByName(name);
            if (found) {
              existing = {
                ...toAttributes(found),
                hash: output?.hash,
              };
            }
          }

          // Only use cached attachment data after confirming the application
          // is missing. An observed live attachment outranks stale state.
          const recordedDurableObjects = existing
            ? existing.durableObjects
            : output?.accountId === accountId && isLiveId(output.applicationId)
              ? output.durableObjects
              : undefined;
          const durableObjectsForRecovery =
            durableObjects ??
            (hasUnresolvedAttachment && recordedDurableObjects?.namespaceId
              ? recordedDurableObjects
              : undefined);
          if (hasUnresolvedAttachment && durableObjectsForRecovery === undefined) {
            return yield* Effect.fail(
              new Error(
                `Container application "${name}" has an unresolved Durable Object namespace and no recorded attachment. Reconcile its Worker first.`,
              ),
            );
          }
          const { build, imageRef, imageHash, dev } = yield* computeImage(id, news, env);

          // Special case: precreate produced an application without the
          // durable object attachment, but the real reconcile now has one.
          // The DO attachment is immutable, so we delete
          // and recreate. Adoption-by-namespace is preferred when an app
          // already owns the namespace.
          // An unresolved declaration is not an intentional removal.
          if (
            existing &&
            !hasUnresolvedAttachment &&
            !deepEqual(existing.durableObjects, durableObjects)
          ) {
            if (durableObjects) {
              const owner = yield* findApplicationByNamespace(durableObjects.namespaceId);
              const recovery = resolveDurableObjectApplicationRecovery({
                namespaceId: durableObjects.namespaceId,
                expectedName: name,
                existingName: owner?.name,
              });
              if (recovery.canAdopt) {
                if (!owner) {
                  return yield* Effect.fail(
                    new Error(
                      `Container application for Durable Object namespace "${durableObjects.namespaceId}" already exists but could not be found for adoption.`,
                    ),
                  );
                }
                return yield* upsertApplication({
                  id,
                  news,
                  bindings,
                  existing: toAttributes(owner),
                  durableObjects,
                  session,
                });
              }
            }
            const { deploymentImageRef, imageDigest } = yield* resolveDeploymentImage({
              id,
              news,
              existing,
              build,
              imageRef,
              imageHash,
              session,
            });
            const configuration = desiredConfiguration(news, env, deploymentImageRef);
            const configurationHash = yield* applicationConfigurationHash(
              scalingDefaults(news),
              news.affinities,
              configuration,
            );
            yield* Effect.logInfo(
              `Cloudflare Container reconcile: recreating ${name} to attach durable object binding`,
            );
            yield* session.note(
              `Recreating container application ${name} with durable object binding...`,
            );
            yield* Containers.deleteContainerApplication({
              accountId: existing.accountId,
              applicationId: existing.applicationId,
            }).pipe(Effect.catchTag("ContainerApplicationNotFound", () => Effect.void));
            // Wait out the eventually-consistent `list` so the recreate below
            // doesn't re-adopt the just-deleted application and then try to
            // update a now-gone id (see `waitForApplicationDeleted`).
            yield* waitForApplicationDeleted(name, existing.applicationId);
            const result = yield* createApplication({
              id,
              news,
              bindings,
              name,
              configuration,
              durableObjects,
              session,
            });
            return {
              ...("applicationId" in result ? result : toAttributes(result)),
              hash: {
                image: imageHash,
                digest: imageDigest,
                configuration: configurationHash,
              },
              dev,
            };
          }

          // Sync — application exists with correct DO attachment. Apply
          // the desired configuration (image + scheduling + secrets, etc.)
          // through the upsert path, which builds and pushes the image
          // only when the hash changed and creates a rollout if the
          // configuration drifted.
          if (existing) {
            return yield* upsertApplication({
              id,
              news,
              bindings,
              existing,
              // Keep the live attachment through the ghost-recreate fallback
              // when the desired value is unresolved.
              durableObjects: durableObjectsForRecovery,
              session,
            });
          }

          // Ensure — no application exists. Build and push the image,
          // then create. `createApplication` itself tolerates concurrent
          // creates by adopting an existing application with the same
          // name or namespace.
          const published = yield* buildAndPushImage(
            id,
            news,
            build,
            imageRef,
            imageHash,
            undefined,
            session,
          );
          const configuration = desiredConfiguration(news, env, published.imageRef);
          const configurationHash = yield* applicationConfigurationHash(
            scalingDefaults(news),
            news.affinities,
            configuration,
          );
          const result = yield* createApplication({
            id,
            news,
            bindings,
            name,
            configuration,
            durableObjects: durableObjectsForRecovery,
            session,
          });
          return {
            ...("applicationId" in result ? result : toAttributes(result)),
            hash: {
              image: imageHash,
              digest: published.digest,
              configuration: configurationHash,
            },
            dev,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A `dev:` applicationId only exists locally — there is no live
          // application to delete on Cloudflare.
          if (!output.applicationId || !isLiveId(output.applicationId)) return;
          yield* Effect.logInfo(`Cloudflare Container delete: deleting ${output.applicationName}`);
          yield* Containers.deleteContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(Effect.catchTag("ContainerApplicationNotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const readByName = (name: string) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(`Cloudflare Container read: looking up ${name}`);
              const existing = yield* findApplicationByName(name);
              if (!existing) {
                yield* Effect.logInfo(`Cloudflare Container read: ${name} not found`);
                return undefined;
              }
              return {
                ...toAttributes(existing),
                hash: output?.hash,
                // The dev image is a local build-context reference that the
                // API can't return — preserve the persisted one so a refresh
                // doesn't wipe it (which would break a later `alchemy dev`).
                dev: output?.dev,
                images: output?.images,
                devImages: output?.devImages,
              };
            });

          let attrs: ContainerApplication["Attributes"] | undefined;
          // A `dev:` applicationId never exists on Cloudflare — look the
          // application up by its (deterministic) name instead of hitting the
          // API with a fake id.
          if (output?.applicationId && !isLiveId(output.applicationId)) {
            return yield* readByName(output.applicationName);
          }
          if (output?.applicationId) {
            yield* Effect.logInfo(`Cloudflare Container read: checking ${output.applicationName}`);
            attrs = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
                dev: output.dev,
                images: output.images,
                devImages: output.devImages,
              })),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                readByName(output.applicationName),
              ),
            );
            // If we matched by id from prior state, treat as owned.
            return attrs;
          }

          const name = yield* createApplicationName(id, olds?.name);
          attrs = yield* readByName(name);
          if (!attrs) return undefined;
          // Generated names identify this instance by its random suffix.
          // Explicit names alone do not establish ownership.
          return olds?.name === undefined ? attrs : Unowned(attrs);
        }),
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* yield* CloudflareEnvironment;
            // Account-scoped collection. `listContainerApplications` returns
            // the full application objects in one (non-paginated) response, so
            // each item already carries the complete `read` attributes shape —
            // no per-item hydration is required.
            return yield* Containers.listContainerApplications({
              accountId,
            }).pipe(
              Effect.map((apps) => apps.map((app) => toAttributes(app))),
              // Accounts without the containers product reject the route; treat
              // a non-entitled account as an empty collection rather than an
              // error.
              Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
            );
          }),
        tail: ({ output }) =>
          telemetry.tailStream({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
          }),
        logs: ({ output, options }) =>
          telemetry.queryLogs({
            accountId: output.accountId,
            filters: containerFilters(output.applicationId),
            options,
          }),
      });
    }),
  );

const containerFilters = (applicationId: string): TelemetryFilter[] => [
  {
    key: "$metadata.type",
    operation: "eq",
    type: "string",
    value: "cf-container",
  },
  {
    key: "$metadata.service",
    operation: "eq",
    type: "string",
    value: applicationId,
  },
];

const resolveDurableObjectApplicationRecovery = ({
  namespaceId,
  expectedName,
  existingName,
}: {
  namespaceId: string;
  expectedName: string;
  existingName: string | undefined;
}) => {
  if (!existingName) {
    return {
      canAdopt: false as const,
      message: `Container application for Durable Object namespace "${namespaceId}" already exists but could not be found for adoption.`,
    };
  }
  if (existingName !== expectedName) {
    return {
      canAdopt: false as const,
      message: `Existing container application "${existingName}" is already attached to Durable Object namespace "${namespaceId}". Use that application name to adopt it.`,
    };
  }
  return {
    canAdopt: true as const,
  };
};

// Cap each delay at 3s so the readiness window is ~30s over 10 attempts; an
// uncapped `Schedule.exponential(150)` reaches a ~76s single delay by the 10th
// retry (~150s total), which both blows test budgets and needlessly stalls the
// update→create fallback when the target is genuinely gone.
const containerApplicationReadinessSchedule = Schedule.max([
  Schedule.min([Schedule.exponential(150), Schedule.spaced("3 seconds")]),
  Schedule.recurs(10),
]);

const isContainerApplicationNotFound = (
  error: unknown,
): error is Containers.ContainerApplicationNotFound =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  error._tag === "ContainerApplicationNotFound";

/**
 * Right after a Worker upload creates a Durable Object namespace, the
 * containers API can report the namespace missing for a few seconds before it
 * sees it. Retry creates that attach to it, bounded at ~30s.
 */
const retryNamespacePropagation = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      error._tag === "DurableObjectNamespaceNotFound"
        ? Effect.logDebug("Cloudflare Container create: namespace not visible yet, retrying")
        : Effect.void,
    ),
    Effect.retry({
      while: (error) => error._tag === "DurableObjectNamespaceNotFound",
      schedule: Schedule.spaced("2 seconds"),
      times: 15,
    }),
  );

export const retryForContainerApplicationReadiness = <A, E, R>(
  operation: string,
  applicationId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      isContainerApplicationNotFound(error)
        ? Effect.logDebug(
            `Cloudflare Container ${operation}: application ${applicationId} not found yet, retrying`,
          )
        : Effect.void,
    ),
    Effect.retry({
      while: isContainerApplicationNotFound,
      schedule: containerApplicationReadinessSchedule,
    }),
  );

const toAttributes = (
  application:
    | Containers.CreateContainerApplicationResponse
    | Containers.UpdateContainerApplicationResponse
    | Containers.GetContainerApplicationResponse
    | Containers.ListContainerApplicationsResponse[number],
): ContainerApplication["Attributes"] => ({
  applicationId: application.id,
  applicationName: application.name,
  accountId: application.accountId,
  schedulingPolicy: application.schedulingPolicy,
  instances: application.instances ?? undefined,
  maxInstances: application.maxInstances ?? undefined,
  constraints: normalizeNulls(
    application.constraints as ContainerApplication.Constraints | undefined,
  ),
  affinities: normalizeNulls(application.affinities as ContainerApplication.Affinities | undefined),
  configuration: normalizeNulls(
    application.configuration,
  ) as Partial<ContainerApplication.Configuration>,
  observability: normalizeNulls(application.observability ?? undefined),
  durableObjects: normalizeNulls(application.durableObjects) as { namespaceId: string } | undefined,
  createdAt: application.createdAt,
  version: application.version ?? undefined,
  dev: undefined,
});
