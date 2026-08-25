import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as zlib from "node:zlib";
import type * as rolldown from "rolldown";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle, resolveMainPath } from "../../Bundle/TempRoot.ts";
import { Self } from "../../Self.ts";
import { Stack } from "../../Stack.ts";

/**
 * The AWS-managed base image MicroVM Dockerfiles build on. The MicroVM build
 * runs the Dockerfile server-side and snapshots the result with Firecracker.
 */
export const MICROVM_BASE_DOCKER_IMAGE =
  "public.ecr.aws/lambda/microvms:al2023-minimal";

/** The default port the in-VM HTTP server listens on. */
export const DEFAULT_MICROVM_PORT = 8080;

/**
 * Build the final Dockerfile for an effectful MicroVM image. Starts from the
 * user-provided base (or the managed MicroVM base), installs the JS runtime,
 * copies the bundled program, and runs it as the entrypoint. Mirrors the
 * Cloudflare Container `buildFinalDockerfile`, but targets the MicroVM base.
 */
export const buildMicrovmDockerfile = (
  userDockerfile: string | undefined,
  runtime: "bun" | "node",
  port: number,
  /**
   * Binding-contributed Dockerfile statements (`Docker.Host`), already
   * rendered for the image's single target architecture. Spliced after
   * the runtime install and before the bundled program so their layers
   * cache across code changes.
   */
  statements: ReadonlyArray<string> = [],
): string => {
  const base = userDockerfile?.trim() ?? `FROM ${MICROVM_BASE_DOCKER_IMAGE}`;
  const installRuntime =
    runtime === "bun"
      ? // `bun.sh/install` unpacks a zip, so the minimal MicroVM base needs
        // `unzip` (and `tar`) present before the installer runs.
        "RUN dnf install -y unzip tar && curl -fsSL https://bun.sh/install | bash && ln -s /root/.bun/bin/bun /usr/local/bin/bun && dnf clean all"
      : "RUN dnf install -y nodejs && dnf clean all";
  const runtimeBin = runtime === "bun" ? "bun" : "node";
  return [
    base,
    "",
    installRuntime,
    ...statements.flatMap((statement) => ["", statement.trim()]),
    "WORKDIR /app",
    // The entry (`index.mjs`) and every rolldown chunk are emitted with a
    // `.mjs` extension, which Node always treats as ESM — so the entry's named
    // imports of a chunk resolve without needing a `package.json` `"type"`
    // marker (which would risk clobbering a user-provided base image's file).
    "COPY *.mjs /app/",
    `EXPOSE ${port}`,
    `ENV PORT=${port}`,
    `ENTRYPOINT ["${runtimeBin}", "/app/index.mjs"]`,
    "",
  ].join("\n");
};

/**
 * Bundle an Effect-native MicroVM program with Rolldown and wrap it in a
 * generated bootstrap that boots an HTTP server (the MicroVM endpoint). Returns
 * every emitted file so the full set can be zipped into the code artifact.
 *
 * Mirrors `bundleContainerProgram`; the bootstrap provides AWS runtime services
 * (FetchHttpClient + region from env) so in-VM HTTP capability bindings
 * (e.g. S3 `*Http`) resolve against the MicroVM's execution role.
 */
export const bundleMicrovmProgram = Effect.fn(function* ({
  main,
  runtime,
  handler = "default",
  isExternal = false,
  external = [],
  port,
  build,
}: {
  main: string;
  runtime: "bun" | "node";
  handler?: string | undefined;
  isExternal?: boolean;
  external?: string[];
  port: number;
  build?: Bundle.BundleConfig;
}) {
  const stack = yield* Stack;
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const realMain = yield* resolveMainPath(main);
  const cwd = yield* findCwdForBundle(realMain);

  const buildBundle = Effect.fn(function* (
    entry: string,
    plugins?: rolldown.RolldownPluginOption,
  ) {
    return yield* Bundle.build(
      {
        ...build?.input,
        input: entry,
        cwd,
        external: [
          "@aws-sdk/*",
          ...(runtime === "bun" ? ["bun", "bun:*"] : []),
          ...external,
          ...((build?.input?.external as string[] | undefined) ?? []),
        ],
        platform: "node",
        resolve: {
          conditionNames:
            runtime === "bun"
              ? ["bun", "import", "module", "default"]
              : ["node", "import", "module", "default"],
          ...build?.input?.resolve,
        },
        plugins: [build?.input?.plugins, plugins],
        treeshake: true,
      },
      {
        ...build?.output,
        format: "esm",
        sourcemap: build?.output?.sourcemap ?? false,
        minify: build?.output?.minify ?? false,
        entryFileNames: "index.mjs",
        // Emit chunks as `.mjs` too so Node treats them as ESM unconditionally
        // (no `package.json` `"type":"module"` needed in the image).
        chunkFileNames: "[name]-[hash].mjs",
      },
      build,
    );
  });

  const bundleOutput = isExternal
    ? yield* buildBundle(realMain)
    : yield* buildBundle(
        realMain,
        virtualEntryPlugin(
          (importPath) => `
${
  runtime === "bun"
    ? `import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
const HttpServer = BunHttpServer;`
    : `import { NodeServices } from "@effect/platform-node";
import { NodeHttpServer } from "alchemy/Http";
const HttpServer = NodeHttpServer;`
}
import { Stack } from "alchemy/Stack";
import { makeEntrypointLayer } from "alchemy/Runtime";
import { provideProcessTelemetry } from "alchemy/Telemetry";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Context from "effect/Context";
import { MinimumLogLevel } from "effect/References";

import ${handler === "default" ? "entrypoint" : `{ ${handler} as entrypoint }`} from ${JSON.stringify(importPath)};

const tag = Context.Service("${Self.key}")
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  ${runtime === "bun" ? "BunServices.layer" : "NodeServices.layer"},
  FetchHttpClient.layer,
  Logger.layer([Logger.consolePretty()]),
);

const stack = Layer.succeed(Stack, {
  name: ${JSON.stringify(stack.name)},
  stage: ${JSON.stringify(stack.stage)},
  bindings: {},
  resources: {}
});

const serverEffect = tag.pipe(
  // Process-lifetime telemetry: built once into the root scope; exporters
  // batch on their intervals and flush when the scope closes on graceful
  // shutdown.
  Effect.flatMap((func) =>
    func.RuntimeContext.exports.pipe(
      Effect.flatMap((exports) => exports.default),
      provideProcessTelemetry(func.RuntimeContext),
    ),
  ),
  Effect.provide(
    layer.pipe(
      Layer.provideMerge(stack),
      Layer.provideMerge(HttpServer({ port: Number(process.env.PORT ?? ${port}) })),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info")
      ),
    )
  ),
  Effect.scoped
);

console.log("MicroVM bootstrap starting on port ${port}...");
await Effect.runPromise(serverEffect).catch((err) => {
  console.error("MicroVM bootstrap failed:", err);
  process.exit(1);
})`,
        ),
      );

  const files = bundleOutput.files.map((f) => ({
    path: f.path,
    content:
      typeof f.content === "string"
        ? new TextEncoder().encode(f.content)
        : f.content,
  }));

  return { files, hash: bundleOutput.hash };
});

export interface ArtifactFile {
  path: string;
  content: string | Uint8Array;
}

// Fixed DOS timestamp (1980-01-01T00:00:00) so identical inputs always
// produce identical archive bytes.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const textEncoder = new TextEncoder();

/**
 * Zip a flat list of files into a deterministic (fixed mtime) archive. Used to
 * package the MicroVM code artifact (Dockerfile + bundled program, or a build
 * context) before uploading it to S3.
 *
 * Hand-rolled ZIP writer over node's native zlib: build contexts baked into
 * the artifact can be ~1GB, and jszip's pure-JS DEFLATE takes minutes on that
 * where native deflate takes seconds. Compression level 1 — the artifact is
 * decompressed once by the image builder, so speed beats ratio.
 */
export const zipFiles = Effect.fn(function* (
  files: ReadonlyArray<ArtifactFile>,
) {
  if (files.length > 0xffff) {
    return yield* Effect.die(
      `MicroVM artifact has ${files.length} entries, above the non-zip64 limit of 65535`,
    );
  }
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    // One file per Effect step so a multi-hundred-MB archive doesn't starve
    // the event loop for its whole duration.
    const entry = yield* Effect.sync(() => {
      const name = Buffer.from(file.path, "utf8");
      const data =
        typeof file.content === "string"
          ? textEncoder.encode(file.content)
          : file.content;
      const crc = zlib.crc32(data);
      const deflated = zlib.deflateRawSync(data, { level: 1 });
      const stored = deflated.length < data.byteLength;
      const body = stored ? deflated : Buffer.from(data);
      const method = stored ? 8 : 0;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); // local file header signature
      local.writeUInt16LE(20, 4); // version needed to extract
      local.writeUInt16LE(0, 6); // general purpose flags
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(DOS_TIME, 10);
      local.writeUInt16LE(DOS_DATE, 12);
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(data.byteLength, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28); // extra field length

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(0x02014b50, 0); // central directory signature
      cen.writeUInt16LE(0x031e, 4); // made by UNIX, spec 3.0
      cen.writeUInt16LE(20, 6); // version needed to extract
      cen.writeUInt16LE(0, 8); // flags
      cen.writeUInt16LE(method, 10);
      cen.writeUInt16LE(DOS_TIME, 12);
      cen.writeUInt16LE(DOS_DATE, 14);
      cen.writeUInt32LE(crc >>> 0, 16);
      cen.writeUInt32LE(body.length, 20);
      cen.writeUInt32LE(data.byteLength, 24);
      cen.writeUInt16LE(name.length, 28);
      // extra(30), comment(32), disk(34), internal attrs(36) all zero
      cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs: -rw-r--r--
      cen.writeUInt32LE(offset, 42);

      return { local, name, body, cen };
    });
    locals.push(entry.local, entry.name, entry.body);
    central.push(entry.cen, entry.name);
    offset += entry.local.length + entry.name.length + entry.body.length;
    if (offset >= 0xffffffff) {
      return yield* Effect.die(
        "MicroVM artifact exceeds the non-zip64 limit of 4GB",
      );
    }
  }
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, eocd]);
});

/**
 * Recursively read a build-context directory into a flat list of files
 * (relative paths + bytes) for zipping into the code artifact. Used by the
 * external (bring-your-own-Dockerfile) MicroVM mode.
 */
export const readContextDirectory = Effect.fn(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(dir);

  // Enumerate first, then read contents with bounded concurrency — a baked
  // context can hold tens of thousands of files, and reading them one
  // sequential Effect step at a time dominates packaging time.
  const collect = (current: string): Effect.Effect<string[], any, never> =>
    Effect.gen(function* () {
      const entries = yield* fs.readDirectory(current);
      const nested = yield* Effect.forEach(
        entries,
        (entry) =>
          Effect.gen(function* () {
            const abs = path.join(current, entry);
            const info = yield* fs.stat(abs);
            return info.type === "Directory" ? yield* collect(abs) : [abs];
          }),
        { concurrency: 16 },
      );
      return nested.flat();
    });

  const paths = (yield* collect(root)).sort();
  return yield* Effect.forEach(
    paths,
    (abs) =>
      Effect.map(fs.readFile(abs), (content) => ({
        path: path.relative(root, abs),
        content,
      })),
    { concurrency: 16 },
  );
});
