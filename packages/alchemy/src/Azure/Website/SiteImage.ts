import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { AlchemyContext } from "../../AlchemyContext.ts";
import * as Bundle from "../../Bundle/Bundle.ts";
import {
  findCwdForBundle,
  getStableContextDir,
  resolveMainPath,
} from "../../Bundle/TempRoot.ts";
import { isResolved } from "../../Diff.ts";
import { Docker } from "../../Docker/Docker.ts";
import { withRegistryHost } from "../../Docker/Registry.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  copyExtraFiles,
  hashExtraFiles,
  type ExtraFile,
} from "../../Util/extraFiles.ts";
import { sha256Object } from "../../Util/sha256.ts";
import type { Providers } from "../Providers.ts";

export interface SiteImageProps {
  /** Node serve entry (`serve-node.mjs`) bundled into `/app/index.mjs`. */
  main: string;
  /** Build output baked next to the entry (relative to `/app`). */
  extraFiles?: ExtraFile[];
  /** Packages `npm install`ed into the image instead of bundled. */
  install?: string[];
  /** Port the server listens on (`PORT`). */
  port: number;
  /** Image repository name inside the registry. */
  repository: string;
  /** Registry the image is pushed to (ACR login server + admin creds). */
  registry: {
    server: string;
    username: string;
    password: Redacted.Redacted<string>;
  };
}

export interface SiteImage extends Resource<
  "Azure.Website.SiteImage",
  SiteImageProps,
  {
    /** Pushed image reference, `{loginServer}/{repository}:{codeHash}`. */
    imageRef: string;
    /** Content hash of the bundle, extra files, and Dockerfile. */
    codeHash: string;
  },
  never,
  Providers
> {}

/**
 * INTERNAL — the container image behind `Azure.Website.*`: bundles the
 * framework's Node serve entry, bakes the build output next to it, builds
 * the image with the local Docker CLI (`linux/amd64`), and pushes it to the
 * site's Azure Container Registry. The tag is content-addressed, so a new
 * build produces a new revision of the Container App.
 *
 * @internal
 */
export const SiteImage = Resource<SiteImage>("Azure.Website.SiteImage");

const PLATFORM = "linux/amd64";

const dockerfileOf = (props: SiteImageProps) => {
  const lines = [`FROM oven/bun:1`, `WORKDIR /app`, `COPY . /app/`];
  if (props.install !== undefined && props.install.length > 0) {
    lines.push(`RUN bun add ${props.install.join(" ")}`);
  }
  lines.push(
    `ENV PORT=${String(props.port)}`,
    `ENV HOST=0.0.0.0`,
    `EXPOSE ${String(props.port)}`,
    `ENTRYPOINT ["bun", "/app/index.mjs"]`,
  );
  return `${lines.join("\n")}\n`;
};

export const SiteImageProvider = () =>
  Provider.effect(
    SiteImage,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const { dotAlchemy } = yield* AlchemyContext;

      const bundle = Effect.fn(function* (props: SiteImageProps) {
        const realMain = yield* resolveMainPath(props.main);
        const cwd = yield* findCwdForBundle(realMain);
        const bundled = yield* Bundle.build(
          {
            input: realMain,
            cwd,
            platform: "node",
            external: ["bun", "bun:*"],
            resolve: { conditionNames: [...Bundle.BUN_CONDITION_NAMES] },
          },
          {
            format: "esm",
            sourcemap: false,
            minify: false,
            entryFileNames: "index.mjs",
          },
        );
        const dockerfile = dockerfileOf(props);
        const extras = yield* hashExtraFiles(props.extraFiles);
        const codeHash = (yield* sha256Object({
          bundleHash: bundled.hash,
          extras,
          dockerfile,
        })).slice(0, 16);
        return { realMain, bundled, dockerfile, codeHash };
      });

      return SiteImage.Provider.of({
        stables: [],
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const { codeHash } = yield* bundle(news);
          if (codeHash !== output.codeHash) return { action: "update" };
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          return output;
        }),
        reconcile: Effect.fn(function* ({ id, news, session }) {
          yield* session.note(`Bundling ${id}...`);
          const { realMain, bundled, dockerfile, codeHash } =
            yield* bundle(news);
          const contextDir = yield* getStableContextDir(
            realMain,
            dotAlchemy,
            `${id}-azure-image`,
          );
          yield* docker.materialize({
            context: contextDir,
            dockerfile,
            files: bundled.files.map((file, index) => ({
              path: index === 0 ? "index.mjs" : file.path,
              content: file.content,
            })),
          });
          yield* copyExtraFiles(contextDir, news.extraFiles);
          const ref = withRegistryHost(
            `${news.repository}:${codeHash}`,
            news.registry,
          );
          yield* session.note(`Building ${ref}...`);
          yield* docker.image.build({
            context: contextDir,
            tag: ref,
            platform: PLATFORM,
          });
          yield* session.note(`Pushing ${ref} to ${news.registry.server}...`);
          yield* docker.image.push(ref, news.registry, PLATFORM);
          return { imageRef: ref, codeHash };
        }),
        // The image lives in the site's registry, which is deleted with it.
        delete: () => Effect.void,
      });
    }),
  );
