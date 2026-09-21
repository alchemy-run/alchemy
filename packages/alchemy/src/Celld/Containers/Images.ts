import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle, resolveMainPath } from "../../Bundle/TempRoot.ts";
import { deepEqual } from "../../Diff.ts";
import { Docker } from "../../Docker/Docker.ts";
import { sha256 } from "../../Util/sha256.ts";
import type {
  ContainerDeclaration,
  ContainerInstanceType,
  ContainerProgramProps,
} from "./Container.ts";

/** The exact Celld v0.5 ContainerSpec wire shape. */
export interface PreparedContainer {
  /** Exported SQLite Durable Object class. */
  class_name: string;
  /** Immutable image tag contained in the saved archive. */
  image: string;
  /** Native resource sizing. */
  instance_type?: ContainerInstanceType;
  /** Eventually enforced concurrency limit. */
  max_instances?: number;
  /** OCI runtime, never the language runtime. */
  runtime?: string;
}

export interface ContainerImageArtifact {
  /** Content-addressed image tag, celld-image:<sha256>. */
  image: string;
  /** Key relative to the fleet backing-store prefix. */
  key: string;
  /** Docker save archive, including the immutable image tag. */
  path: string;
}

export class ContainerConfigurationError extends Data.TaggedError(
  "Celld.ContainerConfigurationError",
)<{
  readonly message: string;
}> {}

export class ContainerUpdateRequiresQuiescence extends Data.TaggedError(
  "Celld.ContainerUpdateRequiresQuiescence",
)<{
  readonly className: string;
  readonly message: string;
}> {}

/**
 * Native attach() caches the whole spec by cell scope, including idle cells.
 * An isolate reload or destroy() alone is not proof that this cache is gone.
 * Call before moving publication pointers; changes need management quiescence.
 * @internal
 */
export const assertContainerUpdateSafe = (
  previous: readonly PreparedContainer[],
  next: readonly PreparedContainer[],
) =>
  Effect.gen(function* () {
    for (const old of previous) {
      const desired = next.find((entry) => entry.class_name === old.class_name);
      if (!desired || !deepEqual(old, desired)) {
        return yield* Effect.fail(
          new ContainerUpdateRequiresQuiescence({
            className: old.class_name,
            message: `Changing or removing Celld container class '${old.class_name}' requires management quiescence and eviction of native cached containers; dropping the isolate is insufficient`,
          }),
        );
      }
    }
  });

/** Validate and coalesce repeated bindings of one image to one DO class. @internal */
export const validateContainerDeclarations = (
  declarations: readonly ContainerDeclaration[],
) =>
  Effect.gen(function* () {
    const classes = new Map<string, ContainerDeclaration>();
    for (const declaration of declarations) {
      if (
        !declaration.className ||
        !declaration.name ||
        (declaration.maxInstances !== undefined &&
          (!Number.isSafeInteger(declaration.maxInstances) ||
            declaration.maxInstances < 0)) ||
        (declaration.ociRuntime !== undefined &&
          !declaration.ociRuntime.trim()) ||
        ("image" in declaration
          ? !declaration.image.trim()
          : !declaration.main.trim())
      ) {
        return yield* Effect.fail(
          new ContainerConfigurationError({
            message: "Invalid Celld container declaration",
          }),
        );
      }
      const previous = classes.get(declaration.className);
      const { name: _name, ...props } = declaration;
      if (previous) {
        const { name: _previousName, ...oldProps } = previous;
        if (!deepEqual(props, oldProps)) {
          return yield* Effect.fail(
            new ContainerConfigurationError({
              message: `Durable Object '${declaration.className}' cannot own two different container declarations`,
            }),
          );
        }
      } else {
        classes.set(declaration.className, declaration);
      }
    }
    return Array.from(classes.values());
  });

/** Validate the host and same-script class association before any Docker I/O. @internal */
export const validateContainerHost = (options: {
  declarations: readonly ContainerDeclaration[];
  doClasses: readonly string[];
  sqliteClasses: readonly string[];
  hostState?: {
    capabilities?: { containers?: boolean };
    configuration?: {
      capacity?: string;
      cpuArchitecture?: string;
      architecture?: string;
      containerRuntime?: string;
    };
  };
}) =>
  Effect.gen(function* () {
    const declarations = yield* validateContainerDeclarations(
      options.declarations,
    );
    if (declarations.length === 0) return { declarations, platform: undefined };
    const configuration = options.hostState?.configuration;
    if (
      options.hostState?.capabilities?.containers !== true ||
      configuration?.capacity === "fargate"
    ) {
      return yield* Effect.fail(
        new ContainerConfigurationError({
          message:
            "Celld containers require a container-capable host; Fargate cannot run native containers.",
        }),
      );
    }
    for (const declaration of declarations) {
      if (
        !options.doClasses.includes(declaration.className) ||
        !options.sqliteClasses.includes(declaration.className)
      ) {
        return yield* Effect.fail(
          new ContainerConfigurationError({
            message: `Container '${declaration.name}' must name a same-script SQLite Durable Object class: '${declaration.className}'.`,
          }),
        );
      }
      if (
        declaration.ociRuntime !== undefined &&
        declaration.ociRuntime !== "runc" &&
        declaration.ociRuntime !== configuration?.containerRuntime
      ) {
        return yield* Effect.fail(
          new ContainerConfigurationError({
            message: `Container OCI runtime '${declaration.ociRuntime}' is not configured on this host.`,
          }),
        );
      }
    }
    const architecture =
      configuration?.cpuArchitecture ?? configuration?.architecture;
    if (architecture !== "ARM64" && architecture !== "X86_64") {
      return yield* Effect.fail(
        new ContainerConfigurationError({
          message:
            "Container publication requires the host configuration's ARM64 or X86_64 CPU architecture.",
        }),
      );
    }
    const platform: "linux/arm64" | "linux/amd64" =
      architecture === "ARM64" ? "linux/arm64" : "linux/amd64";
    return { declarations, platform };
  });

/** @internal */
export const generatedContainerEntry = (
  main: string,
  runtime: "bun" | "node",
) => `
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { ${runtime === "bun" ? "BunRuntime, BunServices" : "NodeRuntime, NodeServices"} } from "@effect/platform-${runtime}";
import { ${runtime === "bun" ? "BunHttpServer" : "NodeHttpServer"} } from "alchemy/Http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import entry from ${JSON.stringify(main)};
${runtime === "bun" ? "BunRuntime" : "NodeRuntime"}.runMain(entry["~celld/Container/Program"].pipe(
  Effect.scoped,
  Effect.provide(Layer.mergeAll(${runtime === "bun" ? "BunServices.layer, BunHttpServer()" : "NodeServices.layer, NodeHttpServer()"}, FetchHttpClient.layer, RuntimeContext.phantom)),
));
`;

/** Bundle the generated runtime, keeping every emitted chunk. @internal */
export const bundleGeneratedContainer = Effect.fn(function* (
  props: ContainerProgramProps,
  directory: string,
) {
  const main = yield* resolveMainPath(props.main);
  const cwd = yield* findCwdForBundle(main);
  const runtime = props.runtime ?? "bun";
  const virtualEntry = yield* Bundle.virtualEntryPlugin;
  return yield* Bundle.build(
    {
      input: main,
      cwd,
      platform: "node",
      external: runtime === "bun" ? ["bun", "bun:*"] : [],
      resolve: {
        conditionNames:
          runtime === "bun"
            ? [...Bundle.BUN_CONDITION_NAMES]
            : [...Bundle.NODE_CONDITION_NAMES],
      },
      plugins: [
        virtualEntry((entry) => generatedContainerEntry(entry, runtime)),
      ],
    },
    { format: "esm", entryFileNames: "index.mjs", dir: directory },
  );
});

/** Bundle all emitted chunks into a temporary Docker context. @internal */
export const prepareGeneratedContainer = Effect.fn(function* (
  props: ContainerProgramProps,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const docker = yield* Docker;
  const context = yield* fs.makeTempDirectoryScoped({
    prefix: "alchemy-celld-container-",
  });
  const runtime = props.runtime ?? "bun";
  const bundle = yield* bundleGeneratedContainer(props, context);
  yield* docker.materialize({
    context,
    dockerfile: `FROM ${runtime === "bun" ? "oven/bun:1" : "node:22-slim"}\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["${runtime}", "index.mjs"]\n`,
    files: bundle.files.map((file) => ({
      path: file.path,
      content: file.content,
    })),
  });
  return { context, dockerfile: path.join(context, "Dockerfile") };
});

/**
 * Prepare native image archives using Alchemy's existing Docker service.
 * The caller owns archiveDirectory and stages every artifact (including the
 * fence) through stageContainerArtifacts before preparing a deployment. Use its
 * returned descriptors: equivalent builds can produce different save bytes,
 * while the first verified archive for a native identity remains authoritative.
 * No Celld CLI, registry protocol, or runtime image pull is involved.
 * @internal
 */
export const prepareContainerImages = Effect.fn(function* (options: {
  declarations: readonly ContainerDeclaration[];
  platform: "linux/amd64" | "linux/arm64";
  archiveDirectory: string;
  engineContext?: string;
}) {
  const declarations = yield* validateContainerDeclarations(
    options.declarations,
  );
  const docker = yield* Docker;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const artifacts = new Map<string, ContainerImageArtifact>();
  const contextArgs = options.engineContext
    ? ["--context", options.engineContext]
    : [];
  yield* fs.makeDirectory(options.archiveDirectory, { recursive: true });

  const archive = Effect.fn(function* (source: string) {
    const content = yield* docker.run([
      ...contextArgs,
      "image",
      "inspect",
      "--platform",
      options.platform,
      "--format",
      "{{json .RootFS.Layers}}{{json .Config}}",
      source,
    ]);
    const key = yield* sha256(content.stdout.trim());
    const image = `celld-image:${key}`;
    const existing = artifacts.get(image);
    if (existing) return existing;
    yield* docker.image.tag(source, image, options.engineContext);
    const artifact = {
      image,
      key: `deploy/images/${key}.tar`,
      path: path.join(options.archiveDirectory, `${key}.tar`),
    };
    yield* docker.run([
      ...contextArgs,
      "image",
      "save",
      "--platform",
      options.platform,
      "--output",
      artifact.path,
      image,
    ]);
    artifacts.set(image, artifact);
    return artifact;
  });

  const build = Effect.fn(function* (context: string, dockerfile: string) {
    const tag = `alchemy-celld-build:${yield* sha256(context)}`;
    yield* docker.image.build({
      tag,
      context,
      file: dockerfile,
      platform: options.platform,
      engineContext: options.engineContext,
    });
    return yield* archive(tag);
  });

  const containers: PreparedContainer[] = [];
  for (const declaration of declarations) {
    let artifact: ContainerImageArtifact;
    if ("image" in declaration) {
      const local = path.resolve(declaration.image);
      const stat = yield* fs
        .stat(local)
        .pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.undefined,
          ),
        );
      if (stat?.type === "File") {
        artifact = yield* build(path.dirname(local), local);
      } else {
        yield* docker.image.pull(
          declaration.image,
          options.platform,
          options.engineContext,
        );
        artifact = yield* archive(declaration.image);
      }
    } else {
      const generated = yield* prepareGeneratedContainer(declaration);
      artifact = yield* build(generated.context, generated.dockerfile);
    }
    containers.push({
      class_name: declaration.className,
      image: artifact.image,
      ...(declaration.instanceType === undefined
        ? {}
        : { instance_type: declaration.instanceType }),
      ...(declaration.maxInstances === undefined
        ? {}
        : { max_instances: declaration.maxInstances }),
      ...(declaration.ociRuntime === undefined
        ? {}
        : { runtime: declaration.ociRuntime }),
    });
  }
  let fenceImage: string | undefined;
  if (containers.length > 0) {
    const context = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-celld-fence-",
    });
    yield* docker.materialize({
      context,
      dockerfile: "FROM alpine:3.20\nRUN apk add --no-cache nftables\n",
      files: [],
    });
    fenceImage = (yield* build(context, path.join(context, "Dockerfile")))
      .image;
  }
  return { containers, images: Array.from(artifacts.values()), fenceImage };
});
