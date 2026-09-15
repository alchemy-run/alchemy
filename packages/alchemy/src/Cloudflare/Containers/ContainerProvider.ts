import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { Unowned } from "../../AdoptPolicy.ts";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { getStableContextDir } from "../../Bundle/TempRoot.ts";
import { hashDirectory } from "../../Command/Memo.ts";
import { deepEqual, isResolved } from "../../Diff.ts";
import { Docker } from "../../Docker/Docker.ts";
import { repositoryFromImageRef } from "../../Docker/Registry.ts";
import * as Provider from "../../Provider.ts";
import { type ResourceBinding } from "../../Resource.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { isLiveId } from "../LocalRuntime.ts";
import { CloudflareLogs, type TelemetryFilter } from "../Logs.ts";
import type {
  AnyContainerApplicationProps,
  ContainerApplication,
} from "./ContainerApplication.ts";
import { isInlineDockerfile } from "../../Docker/Dockerfile.ts";
import {
  buildFinalDockerfile,
  bundleContainerProgram,
  containerEnvPreamble,
  createContainerApplicationName,
  makeContainerEnv,
  materializeInlineDockerfileContext,
  validateContainerImageProps,
} from "./ContainerBundle.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

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
const normalizePrepushedRef = (
  image: string,
  registryId: string,
  accountId: string,
) => {
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

      const findApplicationByNamespace = Effect.fn(function* (
        namespaceId: string,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;

        return yield* Containers.listContainerApplications({ accountId }).pipe(
          Effect.map((apps) =>
            apps.find((app) => app.durableObjects?.namespaceId === namespaceId),
          ),
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
            times: 10,
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
            props.disk === undefined
              ? "lite"
              : undefined),
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
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
      //   - scheduling_policy: "durable_object"
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
        schedulingPolicy: props.schedulingPolicy ?? "durable_object",
        constraints: props.constraints ?? {},
      });

      const applicationConfigurationHash = Effect.fn(
        "applicationConfigurationHash",
      )(function* (
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
        const credentials =
          yield* Containers.createContainerRegistryCredentials({
            accountId,
            registryId,
            permissions,
            expirationMinutes: 60,
          });
        const username = credentials.username ?? credentials.user;
        if (!username) {
          return yield* new ContainerRegistryError({
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

      const resolveRegistryDigest = Effect.fn("resolveRegistryDigest")(
        function* (
          imageRef: string,
          credentials: {
            server: string;
            username: string;
            password: string | Redacted.Redacted<string>;
          },
        ) {
          const embeddedDigest = digestFromImageRef(imageRef);
          if (embeddedDigest !== undefined) return embeddedDigest;

          const registryHost = credentials.server
            .replace(/^https?:\/\//, "")
            .replace(/\/$/, "");
          if (!imageRef.startsWith(`${registryHost}/`)) {
            return yield* new ContainerRegistryError({
              reason: "ImageOutsideRegistry",
              message: `Cannot resolve an image outside registry ${registryHost}`,
              imageRef,
            });
          }
          const repositoryAndTag = imageRef.slice(registryHost.length + 1);
          const tagSeparator = repositoryAndTag.lastIndexOf(":");
          if (tagSeparator <= repositoryAndTag.lastIndexOf("/")) {
            return yield* new ContainerRegistryError({
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
            HttpClientRequest.basicAuth(
              credentials.username,
              credentials.password,
            ),
            HttpClientRequest.setHeader(
              "Accept",
              "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
            ),
          );
          const response = yield* http.execute(request).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.mapError(
              (cause) =>
                new ContainerRegistryError({
                  reason: "ManifestRequestFailed",
                  message: "Failed to resolve the container registry digest",
                  imageRef,
                  cause,
                }),
            ),
          );
          return yield* Schema.decodeUnknownEffect(RegistryDigest)(
            response.headers["docker-content-digest"],
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ContainerRegistryError({
                  reason: "InvalidManifestDigest",
                  message: "Registry response did not include a valid digest",
                  imageRef,
                  cause,
                }),
            ),
          );
        },
      );

      const resolvePublishedImageRef = Effect.fn("resolvePublishedImageRef")(
        function* (props: AnyContainerApplicationProps, imageRef: string) {
          let digest = digestFromImageRef(imageRef);
          if (digest === undefined) {
            const credentials = yield* registryCredentials(props, ["pull"]);
            digest = yield* resolveRegistryDigest(imageRef, credentials);
          }
          return {
            imageRef: `${repositoryFromImageRef(imageRef)}@${digest}`,
            digest,
          };
        },
      );

      const computeImage = Effect.fn(function* (
        id: string,
        props: AnyContainerApplicationProps,
        env: Record<string, string | Redacted.Redacted<string>>,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const name = yield* createApplicationName(id, props.name);
        const registryId = props.registryId ?? "registry.cloudflare.com";
        const repositoryName = name.toLowerCase();
        const makeRef = (imageHash: string) =>
          `${registryId}/${accountId}/${repositoryName}:${imageHash}`;

        yield* validateContainerImageProps(props);

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
          })).slice(0, 16);
          // Already in the target registry (e.g. pushed by CI as a digest
          // reference) — deploy the reference as-is and skip the docker
          // pull/tag/push round-trip entirely.
          if (isTargetRegistryRef(props.image, registryId)) {
            const prepushedRef = normalizePrepushedRef(
              props.image,
              registryId,
              accountId,
            );
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
        if (
          props.dockerfile !== undefined &&
          isInlineDockerfile(props.dockerfile)
        ) {
          const content = props.dockerfile.content;
          if (typeof content !== "string") {
            return yield* Effect.die(
              new Error(
                "Inline `dockerfile` content is an unresolved Output at image-build time — its dependencies have not resolved yet (e.g. during precreate of a circular binding). Break the cycle or inline the resolved value.",
              ),
            );
          }
          const { context, dockerfile } =
            yield* materializeInlineDockerfileContext(id, content);
          const imageHash = (yield* sha256Object({
            dockerfile: content,
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
        const contextHash = yield* hashDirectory({ cwd: context });
        const dockerfileContent = yield* fs.readFileString(dockerfile);
        const imageHash = (yield* sha256Object({
          contextHash,
          dockerfile: dockerfileContent,
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

      const buildAndPushImage = Effect.fn("buildAndPushImage")(function* (
        id: string,
        props: AnyContainerApplicationProps,
        build: ImageBuild,
        imageRef: string,
        previousImageRef: string | undefined,
        session?: { note: (message: string) => Effect.Effect<void> },
      ) {
        const platform = "linux/amd64";

        if (build.kind === "prepushed") {
          // The reference already lives in the target registry — nothing to
          // pull, build, or push.
          yield* Effect.logInfo(
            `Cloudflare Container image: using pre-pushed ${imageRef}`,
          );
          const published = yield* resolvePublishedImageRef(props, imageRef);
          return {
            ...published,
            previousDigest:
              previousImageRef === undefined
                ? undefined
                : (yield* resolvePublishedImageRef(props, previousImageRef))
                    .digest,
          };
        }

        if (build.kind === "remote") {
          // Pull the pre-built image and re-tag it to the Cloudflare registry
          // reference; nothing is built locally.
          yield* Effect.logInfo(
            `Cloudflare Container image: pulling ${build.image}`,
          );
          if (session) {
            yield* session.note(`Pulling container image ${build.image}...`);
          }
          yield* docker.image.pull(build.image, platform);
          yield* docker.image.tag(build.image, imageRef);
        } else if (build.kind === "external") {
          // Build the user's Dockerfile directly against their context dir so
          // relative `COPY`/`ADD` paths resolve as the author intended.
          yield* Effect.logInfo(
            `Cloudflare Container image: building ${imageRef}`,
          );
          if (session) {
            yield* session.note(`Building container image ${imageRef}...`);
          }
          yield* docker.image.build({
            tag: imageRef,
            context: build.context,
            platform,
            file: build.dockerfile,
          });
        } else {
          // Effect-native program: materialize the generated Dockerfile and
          // bundled chunks into a stable staging dir, then build.
          yield* Effect.logInfo(
            `Cloudflare Container image: building ${imageRef}`,
          );
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
          yield* docker.image.build({
            tag: imageRef,
            context: contextDir,
            platform,
          });
        }

        yield* Effect.logInfo(
          `Cloudflare Container image: pushing ${imageRef}`,
        );
        if (session) {
          yield* session.note(`Pushing container image ${imageRef}...`);
        }

        const credentials = yield* registryCredentials(props, ["pull", "push"]);

        // Cloudflare's container registry intermittently answers blob HEAD
        // probes with 500 under concurrent suite push load. Ride that out
        // with a bounded retry rather than failing the whole deploy.
        //
        // Push the SAME platform we pulled/built. With Docker's containerd
        // image store a tag can hold several platform variants (e.g. a stray
        // host-arch `docker pull` adds arm64 next to our amd64), and an
        // un-scoped push then ships the wrong variant — Cloudflare's amd64
        // hosts never boot it and the app 503s "provisioning" forever.
        yield* docker.image
          .push(
            imageRef,
            {
              username: credentials.username,
              password: credentials.password,
              server: credentials.server,
            },
            platform,
          )
          .pipe(
            Effect.retry({
              while: (e) => {
                const msg = String(e).toLowerCase();
                return (
                  msg.includes("500") ||
                  msg.includes("internal server error") ||
                  msg.includes("unexpected status")
                );
              },
              schedule: Schedule.max([
                Schedule.spaced("3 seconds"),
                Schedule.recurs(5),
              ]),
            }),
          );
        // Resolve the pushed manifest digest from the registry itself rather
        // than scraping `docker push` output: one mechanism for every image
        // source (local build, remote re-push, pre-pushed tag), and the
        // registry is authoritative for what the application will pull.
        const digest = yield* resolveRegistryDigest(imageRef, credentials);
        return {
          imageRef: `${repositoryFromImageRef(imageRef)}@${digest}`,
          digest,
          previousDigest:
            previousImageRef === undefined
              ? undefined
              : yield* resolveRegistryDigest(previousImageRef, credentials),
        };
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
        const stepPercentage =
          strategy === "immediate" ? 100 : (rollout?.stepPercentage ?? 25);

        yield* retryForContainerApplicationReadiness(
          "rollout",
          applicationId,
          Containers.createContainerApplicationRollout({
            accountId,
            applicationId,
            description:
              strategy === "immediate"
                ? "Immediate update"
                : "Progressive update",
            strategy: "rolling",
            kind: rollout?.kind ?? "full_auto",
            stepPercentage,
            targetConfiguration: configuration,
          }),
        );
      });

      const createApplication = Effect.fn(function* (
        name: string,
        news: AnyContainerApplicationProps,
        configuration: ContainerApplication.Configuration,
        durableObjects: Containers.DurableObjectsRef,
      ) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* Containers.createContainerApplication({
          accountId,
          name,
          ...scalingDefaults(news),
          affinities: news.affinities,
          image: configuration.image,
          instanceType: configuration.instanceType ?? undefined,
          environmentVariables: configuration.environmentVariables ?? undefined,
          durableObjects,
        }).pipe(
          Effect.catchTag("DurableObjectAlreadyHasApplication", (error) =>
            Effect.gen(function* () {
              const existing = yield* findApplicationByNamespace(
                durableObjects.namespaceId,
              ).pipe(
                Effect.repeat({
                  schedule: Schedule.spaced("500 millis"),
                  until: (app) => app !== undefined,
                  times: 8,
                }),
              );
              if (
                !existing ||
                existing.name !== name ||
                !sameAttachment(existing.durableObjects, durableObjects)
              ) {
                return yield* Effect.fail(error);
              }
              return existing;
            }),
          ),
          Effect.map(toAttributes),
        );
      });

      const getDurableObjects = (
        bindings: ResourceBinding<ContainerApplication["Binding"]>[],
      ) => {
        const dos = bindings.flatMap((b) =>
          b.data.durableObjects ? [b.data.durableObjects] : [],
        );
        // Repeated bindings must agree on both namespace and hosted class.
        const uniqueDos = dos.filter(
          (d, i, arr) =>
            arr.findIndex((other) => sameAttachment(other, d)) === i,
        );
        if (uniqueDos.length === 0) {
          return Effect.succeed(undefined);
        }
        if (uniqueDos.length === 1) {
          return Effect.succeed(uniqueDos[0]);
        }
        return Effect.fail(
          new Error(
            `A Container can only be bound to one Durable Object namespace and class. Found ${uniqueDos.length} unique namespaces in bindings: ${uniqueDos.map((d) => d.namespaceId).join(", ")}`,
          ),
        );
      };

      return ContainerPlatform.Provider.of({
        stables: ["accountId", "applicationId"],
        diff: Effect.fn(function* ({
          id,
          olds = {},
          news = {},
          output,
          newBindings,
          oldBindings,
        }) {
          if (!isResolved(news) || !isResolved(newBindings)) {
            return undefined;
          }
          const { accountId } = yield* yield* CloudflareEnvironment;

          const oldName =
            output?.applicationName ??
            (yield* createApplicationName(id, olds.name));
          // Auto-generated names are engine-owned: the deployed name stays
          // authoritative even if the generator would name this id differently
          // today. Only an explicit user-provided name can force a replace.
          const name = news.name ?? oldName;

          if (
            (output?.accountId ?? accountId) !== accountId ||
            name !== oldName
          ) {
            return { action: "replace" } as const;
          }

          const desiredAttachment = yield* getDurableObjects(newBindings);
          const previousAttachment =
            (yield* getDurableObjects(oldBindings)) ?? output?.durableObjects;
          if (!sameAttachment(previousAttachment, desiredAttachment)) {
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

          const env = makeContainerEnv(news, accountId, newBindings);
          const { imageHash, imageRef, dev } = yield* computeImage(
            id,
            news,
            env,
          );
          if (imageHash !== output.hash?.image || !deepEqual(dev, output.dev)) {
            return { action: "update" } as const;
          }
          const desiredImage =
            output.hash?.digest &&
            digestFromImageRef(output.configuration.image)
              ? `${repositoryFromImageRef(imageRef)}@${output.hash.digest}`
              : output.configuration.image;
          if (
            !matchesDesired(
              output.configuration,
              desiredConfiguration(news, env, desiredImage),
              desiredConfiguration(olds, {}, desiredImage),
            ) ||
            !matchesDesired(
              output,
              scalingDefaults(news),
              scalingDefaults(olds),
            )
          ) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({
          id,
          news = {},
          olds,
          bindings,
          output,
          session,
        }) {
          const name =
            output?.applicationName ??
            (yield* createApplicationName(id, news.name));
          const durableObjects = yield* getDurableObjects(bindings);
          if (!durableObjects?.namespaceId || !durableObjects.className) {
            return yield* Effect.fail(
              new Error(
                "A live Container application requires a Durable Object namespace and class name. Bind the Container to a Worker or an Effect-native Durable Object before deploying its Application.",
              ),
            );
          }
          if (
            news.schedulingPolicy &&
            news.schedulingPolicy !== "durable_object"
          ) {
            return yield* Effect.fail(
              new Error(
                'Durable Object-backed Containers require schedulingPolicy: "durable_object".',
              ),
            );
          }
          const { accountId } = yield* yield* CloudflareEnvironment;
          const observe = (applicationId: string) =>
            Containers.getContainerApplication({
              accountId,
              applicationId,
            }).pipe(
              Effect.map(toAttributes),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                Effect.succeed(undefined),
              ),
            );
          let existing =
            output?.applicationId && isLiveId(output.applicationId)
              ? yield* observe(output.applicationId)
              : undefined;
          if (!existing) {
            const found = yield* findApplicationByName(name);
            // LIST may still contain a deleted application.
            if (found) existing = yield* observe(found.id);
          }

          const env = makeContainerEnv(news, accountId, bindings);
          const { build, imageRef, imageHash, dev } = yield* computeImage(
            id,
            news,
            env,
          );
          let imageDigest = output?.hash?.digest;
          let deploymentImageRef: string;
          if (imageHash === output?.hash?.image && imageDigest) {
            deploymentImageRef = `${repositoryFromImageRef(imageRef)}@${imageDigest}`;
            // Preserve a historical tag only when its live manifest still matches.
            if (existing && !digestFromImageRef(existing.configuration.image)) {
              const published = yield* resolvePublishedImageRef(
                news,
                existing.configuration.image,
              );
              if (published.digest === imageDigest)
                deploymentImageRef = existing.configuration.image;
            }
          } else {
            const published = yield* buildAndPushImage(
              id,
              news,
              build,
              imageRef,
              existing?.configuration.image,
              session,
            );
            imageDigest = published.digest;
            deploymentImageRef =
              existing && published.digest === published.previousDigest
                ? existing.configuration.image
                : published.imageRef;
          }
          const configuration = desiredConfiguration(
            news,
            env,
            deploymentImageRef,
          );
          if (
            !news.instanceType &&
            (news.vcpu !== undefined ||
              news.memory !== undefined ||
              news.disk !== undefined)
          ) {
            configuration.instanceType = null;
          }
          // Explicitly clear fields previously managed by this resource.
          const previousConfiguration = olds
            ? desiredConfiguration(olds, {}, deploymentImageRef)
            : undefined;
          if (previousConfiguration) {
            for (const key of Object.keys(previousConfiguration) as Array<
              keyof ContainerApplication.Configuration
            >) {
              if (!(key in configuration))
                Object.assign(configuration, { [key]: null });
            }
          }
          const scaling = scalingDefaults(news);
          const configurationHash = yield* applicationConfigurationHash(
            scaling,
            news.affinities,
            configuration,
          );

          // Recover historical detached applications without replacing a healthy
          // namespace-only response merely because the binding now has a class.
          if (
            existing &&
            !sameAttachment(existing.durableObjects, durableObjects)
          ) {
            yield* Containers.deleteContainerApplication({
              accountId,
              applicationId: existing.applicationId,
            }).pipe(
              Effect.catchTag(
                "ContainerApplicationNotFound",
                () => Effect.void,
              ),
            );
            yield* waitForApplicationDeleted(name, existing.applicationId);
            existing = undefined;
          }
          if (!existing) {
            yield* session.note(`Creating container application ${name}...`);
            existing = yield* createApplication(
              name,
              news,
              configuration,
              durableObjects,
            );
          }

          let configurationChanged = !matchesDesired(
            existing.configuration,
            configuration,
            previousConfiguration,
          );
          if (
            configurationChanged ||
            !matchesDesired(
              existing,
              {
                ...scaling,
                affinities: news.affinities ?? null,
              },
              olds
                ? { ...scalingDefaults(olds), affinities: olds.affinities }
                : undefined,
            )
          ) {
            yield* session.note(`Updating container application ${name}...`);
            const update = (applicationId: string) =>
              Containers.updateContainerApplication({
                accountId,
                applicationId,
                ...scaling,
                affinities: news.affinities ?? null,
                configuration,
              });
            existing = yield* update(existing.applicationId).pipe(
              Effect.map(toAttributes),
              Effect.catchTag("ContainerApplicationNotFound", () =>
                Effect.gen(function* () {
                  // A delete raced observation. Recreate with the same real
                  // attachment, then sync the fields absent from flat create.
                  const created = yield* createApplication(
                    name,
                    news,
                    configuration,
                    durableObjects,
                  );
                  configurationChanged ||= !matchesDesired(
                    created.configuration,
                    configuration,
                    previousConfiguration,
                  );
                  return yield* retryForContainerApplicationReadiness(
                    "update",
                    created.applicationId,
                    update(created.applicationId),
                  ).pipe(Effect.map(toAttributes));
                }),
              ),
            );
            if (
              configurationChanged ||
              !matchesDesired(
                existing.configuration,
                configuration,
                previousConfiguration,
              )
            ) {
              yield* maybeCreateRollout({
                applicationId: existing.applicationId,
                configuration,
                rollout: news.rollout,
              });
            }
          }
          const observed = yield* retryForContainerApplicationReadiness(
            "read",
            existing.applicationId,
            Containers.getContainerApplication({
              accountId,
              applicationId: existing.applicationId,
            }),
          ).pipe(Effect.map(toAttributes));
          return {
            ...observed,
            durableObjects,
            hash: {
              image: imageHash,
              digest: imageDigest,
              configuration: configurationHash,
            },
            dev,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          // A `dev:` applicationId only exists locally — there is no live
          // application to delete on Cloudflare.
          if (!isLiveId(output.applicationId)) return;
          yield* Effect.logInfo(
            `Cloudflare Container delete: deleting ${output.applicationName}`,
          );
          yield* Containers.deleteContainerApplication({
            accountId: output.accountId,
            applicationId: output.applicationId,
          }).pipe(
            Effect.catchTag("ContainerApplicationNotFound", () => Effect.void),
          );
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const readByName = (name: string) =>
            Effect.gen(function* () {
              yield* Effect.logInfo(
                `Cloudflare Container read: looking up ${name}`,
              );
              const existing = yield* findApplicationByName(name);
              if (!existing) {
                yield* Effect.logInfo(
                  `Cloudflare Container read: ${name} not found`,
                );
                return undefined;
              }
              const observed = yield* Containers.getContainerApplication({
                accountId: existing.accountId,
                applicationId: existing.id,
              }).pipe(
                Effect.catchTag("ContainerApplicationNotFound", () =>
                  Effect.succeed(undefined),
                ),
              );
              if (!observed) return undefined;
              return {
                ...toAttributes(observed),
                hash: output?.hash,
                // The dev image is a local build-context reference that the
                // API can't return — preserve the persisted one so a refresh
                // doesn't wipe it (which would break a later `alchemy dev`).
                dev: output?.dev,
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
            yield* Effect.logInfo(
              `Cloudflare Container read: checking ${output.applicationName}`,
            );
            attrs = yield* Containers.getContainerApplication({
              accountId: output.accountId,
              applicationId: output.applicationId,
            }).pipe(
              Effect.map((app) => ({
                ...toAttributes(app),
                hash: output.hash,
                dev: output.dev,
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
          // Cloudflare container applications carry no ownership signal that
          // we can read back from the API, so a name match is not proof of
          // ownership. Brand it `Unowned` so the engine surfaces
          // `OwnedBySomeoneElse` unless the caller opted in via `--adopt`.
          return Unowned(attrs);
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

const sameAttachment = (
  observed: { namespaceId: string; className?: string } | null | undefined,
  desired: { namespaceId: string; className?: string } | null | undefined,
) =>
  observed?.namespaceId === desired?.namespaceId &&
  (!observed?.className ||
    !desired?.className ||
    observed.className === desired.className);

// Ignore server-added defaults, but include previously managed keys that remain
// observed after removal. Updates send the full desired object, not nested nulls.
const matchesDesired = (
  observed: unknown,
  desired: unknown,
  previous?: unknown,
): boolean => {
  if (desired == null) return observed == null;
  if (Array.isArray(desired)) {
    return (
      (desired.length === 0 && observed == null) || deepEqual(observed, desired)
    );
  }
  if (typeof desired === "object") {
    if (typeof observed !== "object" || observed === null)
      return Object.keys(desired).length === 0;
    const previousObject =
      typeof previous === "object" &&
      previous !== null &&
      !Array.isArray(previous)
        ? previous
        : undefined;
    return (
      Object.entries(desired).every(([key, value]) =>
        matchesDesired(
          Reflect.get(observed, key),
          value,
          previousObject === undefined
            ? undefined
            : Reflect.get(previousObject, key),
        ),
      ) &&
      (previousObject === undefined ||
        Object.entries(previousObject).every(
          ([key, value]) =>
            value == null ||
            key in desired ||
            Reflect.get(observed, key) == null,
        ))
    );
  }
  return observed === desired;
};

// Cap each delay at 3s so the readiness window is ~30s over 10 attempts; an
// uncapped `Schedule.exponential(150)` reaches a ~76s single delay by the 10th
// retry (~150s total), which both blows test budgets and needlessly stalls the
// update→create fallback when the target is genuinely gone.
const containerApplicationReadinessSchedule = Schedule.max([
  Schedule.min([Schedule.exponential(150), Schedule.spaced("3 seconds")]),
  Schedule.recurs(10),
]);

export const retryForContainerApplicationReadiness = <
  A,
  E extends { readonly _tag: string },
  R,
>(
  operation: string,
  applicationId: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.tapError((error) =>
      error._tag === "ContainerApplicationNotFound"
        ? Effect.logDebug(
            `Cloudflare Container ${operation}: application ${applicationId} not found yet, retrying`,
          )
        : Effect.void,
    ),
    Effect.retry({
      while: (error) => error._tag === "ContainerApplicationNotFound",
      schedule: containerApplicationReadinessSchedule,
      times: 10,
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
  instances: application.instances,
  maxInstances: application.maxInstances,
  constraints: normalizeNulls(
    application.constraints as ContainerApplication.Constraints | undefined,
  ),
  affinities: normalizeNulls(
    application.affinities as ContainerApplication.Affinities | undefined,
  ),
  configuration: normalizeNulls(
    application.configuration as ContainerApplication.Configuration,
  ),
  durableObjects: normalizeNulls(application.durableObjects) ?? undefined,
  createdAt: application.createdAt,
  version: application.version,
  dev: undefined,
});
