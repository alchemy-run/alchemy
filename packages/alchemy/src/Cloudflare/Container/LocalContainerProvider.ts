import * as Effect from "effect/Effect";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Artifacts from "../../Artifacts.ts";
import { materializeDockerfile } from "../../Bundle/Docker.ts";
import { getStableContextDir } from "../../Bundle/TempRoot.ts";
import { isResolved } from "../../Diff.ts";
import * as RpcProvider from "../../Local/RpcProvider.ts";
import { sha256Object } from "../../Util/sha256.ts";
import { normalizeNulls } from "../../Util/stable.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { generateLocalId, LOCAL_ENTRY_URL } from "../LocalRuntime.ts";
import type {
  ContainerApplication,
  ContainerApplicationProps,
} from "./ContainerApplication.ts";
import {
  buildFinalDockerfile,
  bundleContainerProgram,
  createContainerApplicationName,
  foldEnvIntoEnvironmentVariables,
} from "./ContainerBundle.ts";
import { ContainerPlatform } from "./ContainerPlatform.ts";

/**
 * Local (dev) provider for Cloudflare Container applications.
 *
 * The Docker build/run is owned by `@distilled.cloud/cloudflare-runtime`; this
 * provider's only job is to bundle the container program once and materialize
 * it into a stable Docker build context, then surface that context as a
 * `dev: ContainerImage.Build` output so the runtime can `docker build` it.
 *
 * Everything else on the attributes is a placeholder: the real
 * `applicationId`/`configuration`/etc. only exist once the live provider
 * promotes this resource on a real deploy. The `applicationId` uses the local
 * id mechanism (`dev:<uuid>`) so the live provider can detect a dev resource
 * and create the real one.
 */
export const LocalContainerProvider = () =>
  RpcProvider.effect(
    ContainerPlatform,
    LOCAL_ENTRY_URL,
    Effect.gen(function* () {
      const { dotAlchemy } = yield* AlchemyContext;

      // Bundle the container entrypoint and write it (plus the generated
      // Dockerfile) into a stable build context directory. `Docker.build` in
      // cloudflare-runtime reads `dockerfile` as a file path and uses
      // `context` as the build context, so we point `dev` at both.
      const prepareImage = Effect.fn(function* (
        id: string,
        news: ContainerApplicationProps,
      ) {
        const main = news.main;
        if (!main) {
          return yield* Effect.die(
            new Error("Container requires a `main` entrypoint."),
          );
        }
        const runtime = news.runtime ?? "bun";
        const context = yield* getStableContextDir(
          process.cwd(),
          dotAlchemy,
          `${id}-container`,
        );
        const dockerfileContent = buildFinalDockerfile(
          news.dockerfile,
          runtime,
          news.external,
          news.autoInstallExternals,
        );
        const [bundle, dockerfile] = yield* Effect.all(
          [
            bundleContainerProgram({
              id,
              main,
              runtime,
              handler: news.handler,
              isExternal: news.isExternal,
              external: news.external,
              outdir: context,
            }),
            materializeDockerfile(dockerfileContent, context),
          ],
          { concurrency: "unbounded" },
        );
        return {
          context,
          dockerfile,
          hash: yield* sha256Object({
            bundle: bundle.hash,
            dockerfileContent,
          }),
        };
      }, Artifacts.cached("container-image"));

      const placeholderConfiguration = (
        props: ContainerApplicationProps,
        accountId: string,
      ) =>
        normalizeNulls({
          image: "local",
          instanceType: props.instanceType,
          observability: props.observability,
          sshPublicKeyIds: props.sshPublicKeyIds,
          secrets: props.secrets,
          vcpu: props.vcpu,
          memory: props.memory,
          disk: props.disk,
          environmentVariables: foldEnvIntoEnvironmentVariables(
            props,
            accountId,
          ),
          labels: props.labels,
          network: props.network,
          command: props.command,
          entrypoint: props.entrypoint,
          dns: props.dns,
          ports: props.ports,
          checks: props.checks,
        }) as ContainerApplication.Configuration;

      const makeAttributes = Effect.fn(function* ({
        id,
        news,
        output,
      }: {
        id: string;
        news: ContainerApplicationProps;
        output: ContainerApplication["Attributes"] | undefined;
      }) {
        const { accountId } = yield* yield* CloudflareEnvironment;
        const { context, hash, dockerfile } = yield* prepareImage(id, news);
        return {
          applicationId: output?.applicationId ?? generateLocalId(),
          applicationName: yield* createContainerApplicationName(id, news.name),
          accountId: output?.accountId ?? accountId,
          schedulingPolicy: news.schedulingPolicy ?? "default",
          instances: news.instances ?? 1,
          maxInstances: news.maxInstances ?? 1,
          constraints: news.constraints,
          affinities: news.affinities,
          configuration: placeholderConfiguration(news, accountId),
          durableObjects: undefined,
          createdAt: new Date().toISOString(),
          version: 1,
          dev: { context, dockerfile },
          hash: { image: hash },
        } satisfies ContainerApplication["Attributes"];
      });

      return {
        // No HMR for containers (yet): bundle once on first reconcile, then
        // treat the resource as a no-op so subsequent reconciles don't
        // re-bundle on every change.
        stables: ["accountId", "applicationId"],
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!output) return { action: "update" };
          if (!isResolved(news)) return undefined;
          const input = yield* prepareImage(id, news);
          return input.hash !== output.hash?.image
            ? { action: "update" }
            : undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        // Precreate breaks the worker <-> container cycle: the worker depends
        // on the container's `dev` image, while the container binds the
        // worker-hosted Durable Object namespace. Building the image here lets
        // the worker resolve `dev` without waiting on the container's reconcile.
        precreate: Effect.fn(function* ({ id, news }) {
          return yield* makeAttributes({ id, news, output: undefined });
        }),
        reconcile: Effect.fn(function* ({ id, news, output }) {
          return yield* makeAttributes({ id, news, output });
        }),
        delete: Effect.fn(function* () {
          // Nothing to tear down: the build context lives under `.alchemy/tmp`
          // and is reused across runs; the running container is owned by the
          // worker runtime.
        }),
      };
    }),
  );
