import * as Effect from "effect/Effect";
import type * as rolldown from "rolldown";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Bundle from "../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../Bundle/TempRoot.ts";
import { Self } from "../Self.ts";
import { sha256Object } from "../Util/sha256.ts";
import { Docker } from "./Docker.ts";

/**
 * INTERNAL — image machinery for the effectful `Docker.Service` platform.
 *
 * NOT exported from the Docker barrel. Bundles a `main` Effect program with
 * rolldown, bakes it into a generated bun Dockerfile, and builds the image
 * with the Docker CLI against the service's Docker context — so the image is
 * present in the exact engine the Swarm service schedules from. There is no
 * registry push: the built image is content-addressed (`<name>:<hash>`) and
 * only rebuilt when the bundle, Dockerfile, or environment image changes.
 *
 * Multi-node swarms need the image on every node; for those, build with
 * `Docker.Image` + a `registry` and pass the pushed ref as `image` instead.
 */

/** The props subset that describes a bundled `main` service image. */
export interface BundledServiceSource {
  main: string;
  image?: string;
  handler?: string;
  port?: number;
  /**
   * Bundler configuration for `main`: rolldown `input`/`output` overrides
   * plus pure-annotation options (`pure`). `effect`, `@effect/*`,
   * `alchemy`, `@alchemy.run/*`, and `@distilled.cloud/*` are annotated as
   * pure by default so unused code from those packages is tree-shaken; list
   * additional packages via `pure.packages`, or disable with `pure: false`.
   */
  build?: Bundle.BundleConfig;
}

/** The resolved (built) local image. */
export interface ResolvedServiceImage {
  /** Full image reference, `<name>:<codeHash>`. */
  imageRef: string;
  /** Content hash identifying the image (also the image tag). */
  codeHash: string;
}

/**
 * The standard bun bootstrap wrapped around a `Docker.Service` `main` entry:
 * resolves the bundled program's registered runners (`host.run` loops and the
 * served `fetch` handler) and runs them with a Bun HTTP server bound to
 * `PORT`. Mirrors the ECS bootstrap minus the AWS credential/region layers —
 * a Swarm task has no ambient cloud identity.
 */
export const makeServiceBunBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "alchemy/Runtime";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

// Normalize the entrypoint export: an inline-effect class default export is
// an Effect resolving the platform instance, while the tagged form
// (X.make(props, impl)) exports a Layer providing the Self tag. Both fold
// into a Layer via makeEntrypointLayer (same pattern as the ECS bridge).
const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.effect(
  Stack,
  Effect.all([
    Config.string("ALCHEMY_STACK_NAME"),
    Config.string("ALCHEMY_STAGE")
  ]).pipe(
    Effect.map(([name, stage]) => ({
      name,
      stage,
      bindings: {},
      resources: {}
    }))
  )
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so the returned { fetch }
// handler is actually served and host.run loops stay alive.
const program = tag.pipe(
  Effect.flatMap((service) => service.RuntimeContext.exports),
  Effect.flatMap((exports) => exports.program),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env)
        )
      ),
    )
  ),
  Effect.scoped
);

console.log("Docker service bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Docker service bootstrap failed:", err);
  process.exit(1);
});
`;

/**
 * Init-time constructor for the service-image resolver. Resolves the services
 * that are only available at provider-layer construction (Docker, the
 * `.alchemy` directory, the rolldown virtual-entry plugin) and returns
 * `resolve` (build the image if its content hash isn't present in the target
 * engine) and `hash` (content hash only, for `diff`).
 */
export const makeServiceImage = Effect.gen(function* () {
  const docker = yield* Docker;
  const { dotAlchemy } = yield* AlchemyContext;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  /** Bundle the Effect program behind a `main` source. */
  const bundleProgram = Effect.fn(function* (options: {
    source: BundledServiceSource;
    isExternal?: boolean;
  }) {
    const { source } = options;
    const realMain = yield* resolveMainPath(source.main);
    const cwd = yield* findCwdForBundle(realMain);
    const bootstrap = makeServiceBunBootstrap(source.handler ?? "default");

    const buildBundle = Effect.fn(function* (
      entry: string,
      plugins?: rolldown.RolldownPluginOption,
    ) {
      return yield* Bundle.build(
        {
          ...source.build?.input,
          input: entry,
          cwd,
          platform: "node",
          // The container runs on `bun`; keep `bun`/`bun:*` external (the
          // runtime provides them) and resolve the `bun` export condition
          // so `@effect/platform-bun` picks its Bun implementations.
          external: [
            "bun",
            "bun:*",
            ...((source.build?.input?.external as string[] | undefined) ?? []),
          ],
          resolve: {
            conditionNames: ["bun", "import", "module", "default"],
            ...source.build?.input?.resolve,
          },
          plugins: [source.build?.input?.plugins, plugins],
        },
        {
          ...source.build?.output,
          format: "esm",
          sourcemap: source.build?.output?.sourcemap ?? false,
          minify: source.build?.output?.minify ?? false,
          entryFileNames: "index.mjs",
        },
        source.build,
      );
    });

    const bundleOutput = options.isExternal
      ? yield* buildBundle(realMain)
      : yield* buildBundle(realMain, virtualEntryPlugin(bootstrap));

    // Return every emitted file (entry + shared chunks). Dynamic imports in
    // the Bun HTTP server split into chunks; dropping any of them crashes the
    // container with `Cannot find module './chunk-XXX.js'`.
    const files = bundleOutput.files.map((file) => ({
      path: file.path,
      content:
        typeof file.content === "string"
          ? new TextEncoder().encode(file.content)
          : file.content,
    }));

    return { files, hash: bundleOutput.hash };
  });

  /**
   * Generated Dockerfile for a bundled `main` program. The environment
   * preamble is the `image` ref or the default bun base (`oven/bun` is
   * Docker-Hub only).
   */
  const generateDockerfile = (source: BundledServiceSource) => {
    const lines = [
      `FROM ${source.image ?? "oven/bun:1"}`,
      `WORKDIR /app`,
      `COPY index.mjs /app/index.mjs`,
      // Copy any additional rolldown chunks (`chunk-XXX.js`, …). Non-trivial
      // bundles always emit at least one; minimal bundles emit none and the
      // COPY no-ops.
      `COPY *.js /app/`,
    ];
    if (source.port !== undefined) {
      lines.push(
        `ENV PORT=${String(source.port)}`,
        `EXPOSE ${String(source.port)}`,
      );
    }
    lines.push(`ENTRYPOINT ["bun", "/app/index.mjs"]`);
    return `${lines.join("\n")}\n`;
  };

  /**
   * Bundle a `main` source and compute its content-addressed code hash. The
   * hash covers the full image identity — the bundle output (bootstrap entry
   * included, so bootstrap-template changes invalidate it) and the generated
   * Dockerfile — so `diff` and `resolve` always agree.
   */
  const computeCodeHash = Effect.fn(function* (options: {
    source: BundledServiceSource;
    isExternal?: boolean;
  }) {
    const bundled = yield* bundleProgram(options);
    const dockerfile = generateDockerfile(options.source);
    const codeHash = (yield* sha256Object({
      bundleHash: bundled.hash,
      dockerfile,
    })).slice(0, 16);
    return { bundled, dockerfile, codeHash };
  });

  /** Observe a locally-present tag in the target engine. Missing → undefined. */
  const imageExists = (imageRef: string, context: string | undefined) =>
    docker.image.inspect(imageRef, context).pipe(
      Effect.map(() => true),
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.succeed(false),
      ),
    );

  /**
   * Resolve the image for a bundled service: compute the content-addressed
   * tag, then build only when that exact tag is not already present in the
   * target Docker context (crash-safe convergence).
   */
  const resolve = Effect.fn(function* (options: {
    /** Logical resource id — keys the stable build-context directory. */
    id: string;
    source: BundledServiceSource;
    /** Image repository name (the service's physical name). */
    name: string;
    /** Docker context the swarm service is deployed to. */
    context: string | undefined;
    isExternal?: boolean;
    /** Plan-status session used to emit build progress notes. */
    session: { note: (message: string) => Effect.Effect<void> };
  }) {
    const { id, source, session } = options;
    yield* session.note(`Bundling ${id} program...`);
    const { bundled, dockerfile, codeHash } = yield* computeCodeHash({
      source,
      isExternal: options.isExternal,
    });
    const imageRef = `${options.name}:${codeHash}`;

    if (yield* imageExists(imageRef, options.context)) {
      return { imageRef, codeHash } satisfies ResolvedServiceImage;
    }

    const realMain = yield* resolveMainPath(source.main);
    const contextDir = yield* getStableContextDir(
      realMain,
      dotAlchemy,
      `${id}-image`,
    );
    yield* docker.materialize({
      context: contextDir,
      dockerfile,
      // Entry chunk becomes `index.mjs`; all other chunks keep their emitted
      // `*.js` names so the entry's relative imports resolve.
      files: bundled.files.map((file, index) => ({
        path: index === 0 ? "index.mjs" : file.path,
        content: file.content,
      })),
    });
    yield* session.note(`Building container image ${imageRef}...`);
    yield* docker.image.build({
      context: contextDir,
      tag: imageRef,
      engineContext: options.context,
    });
    yield* session.note(`Built ${imageRef}`);
    return { imageRef, codeHash } satisfies ResolvedServiceImage;
  });

  /**
   * Content hash without building the image. Runs the bundler (bootstrap
   * entry included) so the hash reflects the exact image `resolve` would
   * build — bootstrap-template changes and user-code edits both surface as
   * drift. The provider calls this from `diff` and compares against
   * `output.code.hash`.
   */
  const hash = Effect.fn(function* (options: {
    source: BundledServiceSource;
    isExternal?: boolean;
  }) {
    const { codeHash } = yield* computeCodeHash(options);
    return codeHash;
  });

  return { resolve, hash };
});

/** The resolver service returned by {@link makeServiceImage}. */
export interface ServiceImage extends Effect.Success<typeof makeServiceImage> {}
