import { Docker } from "@alchemy.run/docker/Docker";
import { AlchemyContext } from "alchemy/AlchemyContext";
import {
  normalizeInstallTargets,
  resolvePackageInstallIdentity,
} from "alchemy/Bundle/InstalledPackages";
import { findCwdForBundle, getStableContextDir } from "alchemy/Bundle/TempRoot";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import {
  contextRootOf,
  copyExtraFiles,
  hashExtraFiles,
  posixRelUnder,
  resolveExtraSource,
} from "alchemy/Util/extraFiles";
import { sha256, sha256Object } from "alchemy/Util/sha256";
import { packSiteExtraFiles } from "alchemy/Website/packExtraFiles";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import { FUNCTION_PLATFORM, FUNCTION_PORT } from "../Functions/internal.ts";
import { pushedDigestReference } from "../internal/pushImage.ts";
import type { Providers } from "../Providers.ts";
import { purgeableFiles, resolveSource } from "./internal.ts";

/** Base image of a website's server: frameworks run on Node, not on bun. */
const NODE_BASE_IMAGE = "node:26-slim";

export interface ServerImageProps {
  /** The build's serve entry, e.g. a `Website.Server`'s `serverEntry`. */
  serverEntry: string | undefined;
  /** The build's output directory, e.g. a `Website.Server`'s `distDir`. */
  distDir: string | undefined;
  /** The build's client directory, whose unhashed files a deploy may purge. */
  clientDir?: string | undefined;
  /**
   * `client` ships the whole output directory. `next` ships `.next`, `public` and
   * `next.config.*` from the app root.
   * @default "client"
   */
  layout?: "client" | "next";
  /** Packages installed in the image instead of shipped, such as `next`. */
  install?: string[];
  /** Hash of the build. A new value checks the image again. */
  buildHash?: string | undefined;
  /** Repository to push to, with the registry host and without a tag. */
  repository: string;
  /** Login for the push. Omit to use the deploying machine's `docker login`. */
  username?: string;
  /** Password or token for the push. */
  password?: string | Redacted.Redacted<string>;
  /** `htmlHandling` of the site, which decides the URLs of its files. */
  htmlHandling?: "none" | "drop-trailing-slash";
}

export type ServerImage = Resource<
  "Stackit.Website.ServerImage",
  ServerImageProps,
  {
    /** The pushed image, pinned by digest: `<repository>@sha256:...`. */
    image: string;
    /** Repository the image is in. */
    repository: string;
    /** Hash of the image's content. */
    codeHash: string;
    /** The client directory's unhashed files by URL path. */
    purgeable: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * The OCI image of a website's server: the framework's build output and Node,
 * pushed to a registry and pinned by digest, for `Stackit.Functions.Function`'s
 * `image` prop. STACKIT Functions runs only OCI images, so this is how server
 * rendering gets onto a function. It is built with Docker on the deploying
 * machine, and an unchanged build pushes nothing. A destroy leaves the images in
 * their registry, like the revisions a Function prunes.
 *
 * The framework sites use this internally.
 *
 * ### Building the Image
 * **Example:** A framework build as an image
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const image = yield* Stackit.Website.ServerImage("Image", {
 *   serverEntry: build.serverEntry,
 *   distDir: build.distDir,
 *   repository: "ghcr.io/my-org/web",
 * });
 * const server = yield* Stackit.Functions.Function("Server", { image: image.image });
 * ```
 *
 * @resource
 * @product Website
 */
export const ServerImage = Resource<ServerImage>("Stackit.Website.ServerImage");

/** The build wrote no server to put in an image: the site is assets-only. */
export class ServerEntryMissing extends Data.TaggedError("Stackit.Website.ServerEntryMissing")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

const dockerfileOf = (entry: string, install: boolean) =>
  [
    `FROM ${NODE_BASE_IMAGE}`,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    ...(install
      ? [
          "COPY package.json /app/package.json",
          // Drop npm's download cache so it isn't pushed with the image.
          "RUN npm install --omit=dev --no-fund --no-audit && npm cache clean --force",
        ]
      : []),
    "COPY . /app",
    "ENV HOST=0.0.0.0",
    `ENV PORT=${String(FUNCTION_PORT)}`,
    `EXPOSE ${String(FUNCTION_PORT)}`,
    `ENTRYPOINT ["node", ${JSON.stringify(`/app/${entry}`)}]`,
    "",
  ].join("\n");

/** Everything that decides the image: its hash, and what to build it from. */
const programOf = Effect.fn(function* (id: string, news: ServerImageProps) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (news.serverEntry === undefined || news.distDir === undefined) {
    return yield* new ServerEntryMissing({
      resourceName: id,
      message: `${id}: the build produced no server. Serve an assets-only build from a bucket.`,
    });
  }
  const main = yield* resolveSource(news.serverEntry);
  const distDir = yield* resolveSource(news.distDir);
  const extraFiles = (yield* packSiteExtraFiles(distDir, news.layout ?? "client")) ?? [];
  const root = contextRootOf(main, extraFiles, path, (file) => resolveExtraSource(file, path));
  const entry = posixRelUnder(root, main, path) || path.basename(main);
  const requested = yield* normalizeInstallTargets(news.install);
  const cwd = yield* findCwdForBundle(main);
  const identity =
    Object.keys(requested).length > 0
      ? yield* resolvePackageInstallIdentity({ cwd, requested })
      : undefined;
  const packageJson =
    identity !== undefined && Object.keys(identity.resolved).length > 0
      ? `${JSON.stringify({ private: true, type: "module", dependencies: identity.resolved }, null, 2)}\n`
      : undefined;
  const dockerfile = dockerfileOf(entry, packageJson !== undefined);
  const mainBytes = yield* fs.readFile(main);
  const mainHash = yield* sha256(mainBytes);
  const extraHashes = yield* hashExtraFiles(extraFiles);
  const hash = yield* sha256Object({
    main: mainHash,
    entry,
    dockerfile,
    packageJson,
    lockfile: identity?.lockfile,
    extraFiles: extraHashes,
    platform: FUNCTION_PLATFORM,
  });
  const codeHash = hash.slice(0, 16);
  return { main, entry, extraFiles, packageJson, dockerfile, codeHash };
});

export const ServerImageProvider = () =>
  Provider.succeed(ServerImage, {
    // Nothing to enumerate: images belong to their registry.
    list: () => Effect.succeed([]),

    read: ({ output }) => Effect.succeed(output),

    diff: Effect.fn(function* ({ id, news, output }) {
      if (output === undefined || !isResolved(news)) return undefined;
      // A lockfile change leaves the props untouched: hash the program.
      const program = yield* programOf(id, news);
      return program.codeHash !== output.codeHash ? ({ action: "update" } as const) : undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session }) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const docker = yield* Docker;
      const { dotAlchemy } = yield* AlchemyContext;
      const program = yield* programOf(id, news);
      const clientDir =
        news.clientDir === undefined ? undefined : yield* resolveSource(news.clientDir);
      const purgeable =
        clientDir === undefined
          ? {}
          : yield* purgeableFiles(clientDir, { htmlHandling: news.htmlHandling });
      if (output?.codeHash === program.codeHash && output.image.startsWith(`${news.repository}@`)) {
        return { ...output, purgeable };
      }
      const imageUri = `${news.repository}:${program.codeHash}`;
      // Hash-keyed so a stale tree from an earlier build never leaks in.
      const context = yield* getStableContextDir(
        program.main,
        dotAlchemy,
        `${id}-site-${program.codeHash}`,
      );
      yield* docker.materialize({
        context,
        dockerfile: program.dockerfile,
        files:
          program.packageJson !== undefined
            ? [{ path: "package.json", content: program.packageJson }]
            : [],
      });
      yield* copyExtraFiles(context, program.extraFiles);
      const entryPath = path.join(context, program.entry);
      if (!(yield* fs.exists(entryPath))) {
        yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
        yield* fs.copy(program.main, entryPath, { overwrite: true });
      }
      yield* session.note(`Building ${imageUri}...`);
      const image = yield* docker.image
        .build({ tag: imageUri, context, platform: FUNCTION_PLATFORM })
        .pipe(
          Effect.andThen(
            pushedDigestReference({
              id,
              imageUri,
              registry: {
                repository: news.repository,
                username: news.username,
                password: news.password,
              },
            }),
          ),
          Effect.ensuring(fs.remove(context, { recursive: true }).pipe(Effect.ignore)),
        );
      yield* session.note(`Pushed ${image}`);
      return { image, repository: news.repository, codeHash: program.codeHash, purgeable };
    }),

    // Images stay in their registry, as they do for a Function's pruned revisions.
    delete: () => Effect.void,
  });
