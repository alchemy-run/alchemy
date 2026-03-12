import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as ServiceMap from "effect/ServiceMap";
import type { ScopedPlanStatusSession } from "../../Cli/Cli.ts";
import { sha256 } from "../../Util/index.ts";
import { Worker } from "./Worker.ts";

const MAX_ASSET_SIZE = 1024 * 1024 * 25; // 25MB
const MAX_ASSET_COUNT = 20_000;

export interface AssetReadResult {
  directory: string;
  config: Worker.AssetsConfig | undefined;
  manifest: Record<string, { hash: string; size: number }>;
  _headers: string | undefined;
  _redirects: string | undefined;
}

export class Assets extends ServiceMap.Service<
  Assets,
  {
    read(
      directory: Worker.AssetsProps,
    ): Effect.Effect<AssetReadResult, PlatformError | ValidationError>;
    upload(
      accountId: string,
      workerName: string,
      assets: AssetReadResult,
      session: ScopedPlanStatusSession,
    ): Effect.Effect<
      { jwt: string | undefined },
      | PlatformError
      | ValidationError
      | workers.CreateScriptAssetUploadError
      | workers.CreateAssetUploadError
    >;
  }
>()("Cloudflare.Assets") {}

export type ValidationError =
  | AssetTooLargeError
  | TooManyAssetsError
  | AssetNotFoundError
  | FailedToReadAssetError;

export class AssetTooLargeError extends Data.TaggedError("AssetTooLargeError")<{
  message: string;
  name: string;
  size: number;
}> {}

export class TooManyAssetsError extends Data.TaggedError("TooManyAssetsError")<{
  message: string;
  directory: string;
  count: number;
}> {}

export class AssetNotFoundError extends Data.TaggedError("AssetNotFoundError")<{
  message: string;
  hash: string;
}> {}

export class FailedToReadAssetError extends Data.TaggedError(
  "FailedToReadAssetError",
)<{
  message: string;
  name: string;
  cause: PlatformError;
}> {}

export const AssetsProvider = () =>
  Layer.effect(
    Assets,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const createScriptAssetUpload = yield* workers.createScriptAssetUpload;
      const createAssetUpload = yield* workers.createAssetUpload;

      const maybeReadString = Effect.fnUntraced(function* (file: string) {
        return yield* fs.readFileString(file).pipe(
          Effect.catchIf(
            (error) =>
              error._tag === "PlatformError" &&
              error.reason._tag === "NotFound",
            () => Effect.succeed(undefined),
          ),
        );
      });

      const createIgnoreMatcher = Effect.fnUntraced(function* (
        patterns: string[],
      ) {
        const matcher = yield* Effect.promise(() =>
          import("ignore").then(({ default: ignore }) =>
            ignore().add(patterns),
          ),
        );
        return (file: string) => matcher.ignores(file);
      });

      return {
        read: Effect.fnUntraced(function* (props: Worker.AssetsProps) {
          const resolvedDirectory = path.resolve(props.directory);
          const [files, ignore, _headers, _redirects] = yield* Effect.all([
            fs.readDirectory(resolvedDirectory, { recursive: true }),
            maybeReadString(path.join(resolvedDirectory, ".assetsignore")),
            maybeReadString(path.join(resolvedDirectory, "_headers")),
            maybeReadString(path.join(resolvedDirectory, "_redirects")),
          ]);
          const ignores = yield* createIgnoreMatcher([
            ".assetsignore",
            "_headers",
            "_redirects",
            ...(ignore
              ?.split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0 && !line.startsWith("#")) ??
              []),
          ]);
          const manifest = new Map<string, { hash: string; size: number }>();
          let count = 0;
          yield* Effect.forEach(
            files,
            Effect.fnUntraced(function* (name) {
              if (ignores(name)) {
                return;
              }
              const file = path.join(resolvedDirectory, name);
              const stat = yield* fs.stat(file);
              if (stat.type !== "File") {
                return;
              }
              const size = Number(stat.size);
              if (size > MAX_ASSET_SIZE) {
                return yield* new AssetTooLargeError({
                  message: `Asset ${name} is too large (the maximum size is ${MAX_ASSET_SIZE / 1024 / 1024} MB; this asset is ${size / 1024 / 1024} MB)`,
                  name,
                  size,
                });
              }
              const hash = yield* fs.readFile(file).pipe(
                Effect.flatMap(sha256),
                Effect.map((hash) => hash.slice(0, 32)),
              );
              count++;
              if (count > MAX_ASSET_COUNT) {
                return yield* new TooManyAssetsError({
                  message: `Too many assets (the maximum count is ${MAX_ASSET_COUNT}; this directory has ${count} assets)`,
                  directory: props.directory,
                  count,
                });
              }
              manifest.set(name.startsWith("/") ? name : `/${name}`, {
                hash,
                size,
              });
            }),
          );
          return {
            directory: props.directory,
            config: props.config,
            manifest: Object.fromEntries(
              Array.from(manifest.entries()).sort((a, b) =>
                a[0].localeCompare(b[0]),
              ),
            ),
            _headers,
            _redirects,
          };
        }),
        upload: Effect.fnUntraced(function* (
          accountId: string,
          workerName: string,
          assets: AssetReadResult,
          { note }: ScopedPlanStatusSession,
        ) {
          yield* note("Checking assets...");
          const session = yield* createScriptAssetUpload({
            accountId,
            scriptName: workerName,
            manifest: assets.manifest,
          });
          if (!session.buckets?.length) {
            return { jwt: session.jwt ?? undefined };
          }
          let uploaded = 0;
          const total = session.buckets.flat().length;
          yield* note(`Uploaded ${uploaded} of ${total} assets...`);
          const assetsByHash = new Map<string, string>();
          for (const [name, { hash }] of Object.entries(assets.manifest)) {
            assetsByHash.set(hash, name);
          }
          let jwt: string | undefined | null;
          const directory = path.resolve(assets.directory);
          yield* Effect.forEach(
            session.buckets,
            Effect.fnUntraced(function* (bucket) {
              const body: Record<string, string> = {};
              yield* Effect.forEach(
                bucket,
                Effect.fnUntraced(function* (hash) {
                  const name = assetsByHash.get(hash);
                  if (!name) {
                    return yield* new AssetNotFoundError({
                      message: `Asset ${hash} not found in manifest`,
                      hash,
                    });
                  }
                  const file = yield* fs
                    .readFile(path.join(directory, name))
                    .pipe(
                      Effect.mapError(
                        (error) =>
                          new FailedToReadAssetError({
                            message: `Failed to read asset ${name}: ${error.message}`,
                            name,
                            cause: error,
                          }),
                      ),
                    );
                  body[hash] = Buffer.from(file).toString("base64");
                }),
              );
              const result = yield* createAssetUpload({
                accountId,
                base64: true,
                body,
              });
              uploaded += bucket.length;
              yield* note(`Uploaded ${uploaded} of ${total} assets...`);
              if (result.jwt) {
                jwt = result.jwt;
              }
            }),
          );
          return { jwt: jwt ?? undefined };
        }),
      };
    }),
  );
