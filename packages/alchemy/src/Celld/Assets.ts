import { createHash } from "node:crypto";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { contentTypeOf } from "../Website/assets.ts";
import type { DeploymentAssets } from "./Deployment.ts";
import { DeploymentError } from "./Deployment/Objects.ts";
import type { CelldAssetsConfig } from "./DeploymentConfig.ts";

const maxFiles = 20_000;
const maxFileBytes = 25 * 1024 * 1024;
const maxTotalBytes = 1024 * 1024 * 1024;
const maxDirectiveBytes = 100 * 1024;

const refuse = (message: string) =>
  Effect.fail(new DeploymentError({ reason: "configuration", message }));

// Celld's native table omits unknown extensions and gives JSON a charset.
const assetContentType = (
  name: string,
  extension: string,
): string | undefined => {
  switch (extension) {
    case ".html":
    case ".htm":
    case ".css":
    case ".js":
    case ".mjs":
    case ".txt":
    case ".svg":
    case ".wasm":
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".gif":
    case ".webp":
    case ".ico":
    case ".woff":
    case ".woff2":
    case ".br":
      return contentTypeOf(name);
    case ".cjs":
      return contentTypeOf("asset.js");
    case ".json":
    case ".map":
      return `${contentTypeOf(name)}; charset=utf-8`;
    case ".xml":
      return "application/xml; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".avif":
      return "image/avif";
    case ".pdf":
      return "application/pdf";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".ogg":
      return "audio/ogg";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".zip":
      return "application/zip";
    case ".gz":
      return "application/gzip";
    default:
      return undefined;
  }
};

/**
 * Read native Celld 0.5 assets relative to the Worker's entry module.
 *
 * The directory must remain inside the entry module's directory. Symbolic
 * links, special files, reserved Worker source and `.assetsignore` are refused.
 * Root `_headers` and `_redirects` files become index configuration; nested
 * files with those names remain assets. Blobs are deduplicated by SHA-256.
 * Limits match Celld: 20,000 files, 25 MiB per file, 1 GiB total, 100 KiB per
 * directive and 1,024 UTF-8 bytes per URL path. Names also obey the deployment
 * preparer's stricter path rules: no whitespace, percent signs or URL delimiters.
 * The directory must not be concurrently modified while it is read.
 *
 * ### Prepare an asset index
 * **Example:** Read a directory beside the Worker entry module
 * ```typescript
 * const assets = yield* readAssets(import.meta.url, {
 *   directory: "public",
 *   binding: "ASSETS",
 *   notFoundHandling: "single-page-application",
 * }, { date: "2026-01-01", flags: [] });
 * ```
 */
export const readAssets = (
  main: string,
  config: CelldAssetsConfig,
  compatibility: { date: string; flags: readonly string[] },
): Effect.Effect<
  DeploymentAssets,
  DeploymentError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!main || main.includes("\0"))
      return yield* refuse(
        "A Worker entry module is required to resolve assets.",
      );
    const isFileUrl = /^file:/i.test(main);
    const mainPath = isFileUrl
      ? yield* path.fromFileUrl(
          yield* Effect.try({
            try: () => new URL(main),
            catch: (cause) =>
              new DeploymentError({
                reason: "configuration",
                message: "Invalid Worker entry file URL.",
                cause,
              }),
          }),
        )
      : main;
    if (
      !isFileUrl &&
      /^[a-z][a-z\d+.-]*:/i.test(main) &&
      !/^[a-z]:[\\/]/i.test(main)
    ) {
      return yield* refuse(
        "Worker assets require a file URL or filesystem entry path.",
      );
    }
    const directory = config.directory.replace(/^\.\//, "");
    const components = directory
      .split(/[\\/]/)
      .filter((component) => component !== "");
    if (
      !directory ||
      components.length === 0 ||
      path.isAbsolute(directory) ||
      /^[a-z]:/i.test(directory) ||
      directory.includes("\0") ||
      components.some((component) => component === "." || component === "..")
    ) {
      return yield* refuse(
        "assets.directory must be a path inside the Worker entry module's directory.",
      );
    }
    if (
      config.binding !== undefined &&
      !/^[$A-Z_a-z][$\w]{0,127}$/.test(config.binding)
    )
      return yield* refuse("Invalid asset binding name.");
    const htmlHandling = config.htmlHandling ?? "auto-trailing-slash";
    const notFoundHandling = config.notFoundHandling ?? "none";
    if (
      ![
        "auto-trailing-slash",
        "force-trailing-slash",
        "drop-trailing-slash",
        "none",
      ].includes(htmlHandling)
    )
      return yield* refuse("Unsupported asset htmlHandling.");
    if (
      !["none", "404-page", "single-page-application"].includes(
        notFoundHandling,
      )
    )
      return yield* refuse("Unsupported asset notFoundHandling.");
    const runWorkerFirst = config.runWorkerFirst ?? false;
    if (Array.isArray(runWorkerFirst)) {
      if (
        runWorkerFirst.length === 0 ||
        runWorkerFirst.length > 100 ||
        new Set(runWorkerFirst).size !== runWorkerFirst.length ||
        !runWorkerFirst.some((route) => route.startsWith("/"))
      )
        return yield* refuse(
          "Asset worker-first routes require 1–100 unique rules and a positive rule.",
        );
      for (const route of runWorkerFirst) {
        const length = yield* Effect.sync(
          () => new TextEncoder().encode(route).length,
        );
        if (
          length <= 1 ||
          length > 100 ||
          /[\\\0]/.test(route) ||
          (!route.startsWith("/") && !route.startsWith("!/"))
        )
          return yield* refuse(`Invalid asset worker-first route: ${route}`);
      }
    }

    const projectRoot = yield* fs.realPath(
      path.dirname(path.resolve(mainPath)),
    );
    const inspect = (candidate: string) =>
      Effect.gen(function* () {
        const real = yield* fs.realPath(candidate);
        if (real !== candidate)
          return yield* refuse(
            `Asset tree contains a symbolic link: ${candidate}`,
          );
        return yield* fs.stat(candidate);
      });
    let root = projectRoot;
    for (const component of components) {
      root = path.join(root, component);
      if ((yield* inspect(root)).type !== "Directory")
        return yield* refuse(
          `Asset directory is not a regular directory: ${root}`,
        );
    }

    const readFile = (file: string, limit: number) =>
      Effect.gen(function* () {
        const before = yield* inspect(file);
        if (before.type !== "File")
          return yield* refuse(`Asset is not a regular file: ${file}`);
        if (ByteSize.toBigInt(before.size) > BigInt(limit))
          return yield* refuse(
            `Asset exceeds the ${limit}-byte limit: ${file}`,
          );
        const body = yield* fs.readFile(file);
        const after = yield* inspect(file);
        if (
          body.length > limit ||
          BigInt(body.length) !== ByteSize.toBigInt(before.size) ||
          after.type !== "File" ||
          ByteSize.toBigInt(after.size) !== ByteSize.toBigInt(before.size)
        )
          return yield* refuse(`Asset changed while being read: ${file}`);
        return body;
      });

    const files: { name: string; file: string }[] = [];
    const pending = [{ directory: root, relative: "" }];
    let headers: string | undefined;
    let redirects: string | undefined;
    let observedBytes = 0n;
    while (pending.length) {
      const current = pending.pop()!;
      if ((yield* inspect(current.directory)).type !== "Directory")
        return yield* refuse(
          `Asset directory changed while being read: ${current.directory}`,
        );
      const names = yield* fs.readDirectory(current.directory);
      yield* Effect.sync(() =>
        names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
      );
      for (const name of names) {
        const file = path.join(current.directory, name);
        if (!current.relative && name === ".assetsignore")
          return yield* refuse("Celld 0.5 does not support .assetsignore.");
        if (!current.relative && name === "_worker.js")
          return yield* refuse(
            "Refusing to publish reserved _worker.js source as an asset.",
          );
        if (
          !current.relative &&
          (name === "_headers" || name === "_redirects")
        ) {
          const body = yield* readFile(file, maxDirectiveBytes);
          const text = yield* Effect.try({
            try: () =>
              new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
                body,
              ),
            catch: (cause) =>
              new DeploymentError({
                reason: "configuration",
                message: `Asset directive is not UTF-8: ${file}`,
                cause,
              }),
          });
          if (name === "_headers") headers = text;
          else redirects = text;
          continue;
        }
        const relative = current.relative
          ? `${current.relative}/${name}`
          : name;
        const url = `/${relative}`;
        const length = yield* Effect.sync(
          () => new TextEncoder().encode(url).length,
        );
        if (
          length > 1024 ||
          /[\\\x00-\x20\x7f:%?#]/.test(name) ||
          name === "" ||
          name === "." ||
          name === ".." ||
          name.includes("/")
        )
          return yield* refuse(`Invalid or oversized asset URL path: ${url}`);
        const info = yield* inspect(file);
        if (info.type === "Directory")
          pending.push({ directory: file, relative });
        else if (info.type === "File") {
          const size = ByteSize.toBigInt(info.size);
          if (size > BigInt(maxFileBytes))
            return yield* refuse(`Asset exceeds the 25 MiB file limit: ${url}`);
          observedBytes += size;
          if (observedBytes > BigInt(maxTotalBytes))
            return yield* refuse(
              "Asset directory exceeds the 1 GiB deployment limit.",
            );
          files.push({ name: url, file });
          if (files.length > maxFiles)
            return yield* refuse(
              "Asset directory exceeds the 20,000-file limit.",
            );
        } else
          return yield* refuse(`Asset tree contains a special file: ${file}`);
      }
    }

    yield* Effect.sync(() =>
      files.sort((a, b) =>
        Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)),
      ),
    );
    const entries: DeploymentAssets["index"]["entries"] = {};
    const blobs = new Map<string, Uint8Array>();
    let total = 0;
    for (const { name, file } of files) {
      const body = yield* readFile(file, maxFileBytes);
      total += body.length;
      if (total > maxTotalBytes)
        return yield* refuse(
          "Asset directory exceeds the 1 GiB deployment limit.",
        );
      const sha256 = yield* Effect.sync(() =>
        createHash("sha256").update(body).digest("hex"),
      );
      if (!blobs.has(sha256)) blobs.set(sha256, body);
      const contentType = assetContentType(
        name,
        path.extname(file).toLowerCase(),
      );
      entries[name] = {
        sha256,
        bytes: body.length,
        ...(contentType === undefined ? {} : { content_type: contentType }),
      };
    }
    return {
      index: {
        schema_version: 1,
        entries,
        config: {
          ...(config.binding === undefined ? {} : { binding: config.binding }),
          html_handling: htmlHandling,
          not_found_handling: notFoundHandling,
          run_worker_first: Array.isArray(runWorkerFirst)
            ? [...runWorkerFirst]
            : runWorkerFirst,
          ...(headers === undefined ? {} : { headers }),
          ...(redirects === undefined ? {} : { redirects }),
          compatibility_date: compatibility.date,
          compatibility_flags: [...compatibility.flags],
        },
      },
      blobs: [...blobs.keys()]
        .sort()
        .map((sha256) => ({ sha256, body: blobs.get(sha256)! })),
    };
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof DeploymentError
        ? cause
        : new DeploymentError({
            reason: "configuration",
            message: `Cannot read Celld assets: ${cause.message}`,
            cause,
          }),
    ),
  );
