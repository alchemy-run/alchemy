import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import type { InlineDockerfile } from "@alchemy.run/docker/Dockerfile";
import * as image from "@distilled.cloud/modal/image";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { buildImage, ImageBuildOps, type ImageBuildSpec } from "./ImageBuild.ts";
import { checkCommands, lowerPlan, MODAL_CAPABILITIES } from "./ImagePlan.ts";
import { declarable } from "./internal/Declared.ts";
import type { Providers } from "./Providers.ts";
import { createSandbox, SandboxOps } from "./SandboxClient.ts";

/** A `run` command of a warm-base image exited non-zero. */
export class ImageSetupFailed extends Data.TaggedError("Modal.ImageSetupFailed")<{
  readonly command: string;
  readonly exitCode: number;
  readonly message: string;
}> {}

export interface ImageProps {
  /** The App the image is built in (`Modal.App`). Images are cached per workspace. */
  app: { readonly appId: string; readonly name?: string; readonly environment?: string };
  /**
   * Start from a registry image (`node:22-slim`, `ghcr.io/org/base:1`).
   * Exclusive with {@link dockerfile} and {@link from}.
   */
  image?: string;
  /**
   * Build from a Dockerfile: a path, or inline content
   * (`Dockerfile.inline\`…\``). Modal's builder runs it, not Docker: a
   * multi-stage build, BuildKit mounts, heredocs, `EXPOSE`, `HEALTHCHECK`,
   * `LABEL`, `ONBUILD`, `STOPSIGNAL` and `VOLUME` fail at plan; `USER` is
   * ignored (containers run as root) with a warning.
   */
  dockerfile?: string | InlineDockerfile;
  /** Build context for the Dockerfile's COPY/ADD sources. */
  context?: string;
  /** Start from another `Modal.Image` (a warm base built on a base). */
  from?: { readonly imageId: string };
  /** Dockerfile lines appended to the build (`"RUN pip install pandas"`). */
  commands?: string[];
  /**
   * Shell commands run in a sandbox booted from the built image; its
   * filesystem is then snapshotted into this image. Use it for setup that
   * needs network or secrets at runtime (cloning a repo, installing
   * dependencies), the deploy-time warm base sandboxes fork from.
   */
  run?: string[];
  /** Secrets the build (and `run`) sees as environment variables. */
  secrets?: Array<{ readonly secretId: string }>;
  /** Pull a private base image with credentials stored in a `Modal.Secret`. */
  registry?: {
    readonly type: "aws" | "gcp" | "static";
    readonly secret: { readonly secretId: string };
  };
  /** Run build steps on a GPU (`"A10G"`, `"H100"`). */
  gpu?: string;
  /** Pin Modal's image builder version (`"2025.06"`). */
  builderVersion?: string;
  /**
   * Publish the image under this tag in its app's environment, so code
   * outside the Stack finds it with `images.fromTag(tag)` or
   * `modal.Image.from_tag`.
   */
  tag?: string;
}

export interface ImageAttributes {
  /** Image ID (`im-…`): pass it as `image` when creating sandboxes. */
  imageId: string;
  /** The App the image was built in; `CreateSandbox(image)` creates sandboxes there. */
  appId: string;
  /** Name of that App (for finding its sandboxes by name). */
  appName: string | undefined;
  /** Environment of that App. */
  environment: string | undefined;
  /** Content hash of the build inputs; a change rebuilds. */
  hash: string;
}

/**
 * A Modal Image: a container image built by Modal's own builder (not
 * Docker), from a registry image, a Dockerfile, or another Modal Image plus
 * commands. Sandboxes boot from it.
 *
 * With `run`, the image becomes a warm base: Alchemy boots a sandbox from the
 * built image, runs the commands, snapshots its filesystem, and terminates
 * it. Sandboxes created from the result start with the repo cloned and
 * dependencies installed. Runtime snapshots (`sandbox.snapshotFilesystem()`)
 * are images too and work anywhere an image does.
 *
 * Modal builds remotely: deploying needs no local Docker.
 *
 * ### Building an Image
 * **Example:** From a registry image with extra packages
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Coder = Modal.App("Coder", {});
 * export const Node = Modal.Image("Node", {
 *   app: Coder,
 *   image: "node:22-bookworm",
 *   commands: ["RUN apt-get update && apt-get install -y git ripgrep"],
 * });
 * ```
 *
 * **Example:** From an inline Dockerfile
 * ```typescript
 * import * as Dockerfile from "@alchemy.run/docker/Dockerfile";
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Coder = Modal.App("Coder", {});
 * export const Python = Modal.Image("Python", {
 *   app: Coder,
 *   dockerfile: Dockerfile.inline`
 *     FROM python:3.12-slim
 *     RUN pip install pandas
 *   `,
 * });
 * ```
 *
 * ### A warm base to fork from
 * **Example:** Clone and install once, start every sandbox from it
 * ```typescript
 * import * as Modal from "@alchemy.run/modal";
 *
 * export const Coder = Modal.App("Coder", {});
 * export const Node = Modal.Image("Node", { app: Coder, image: "node:22-bookworm" });
 * export const Warm = Modal.Image("Warm", {
 *   app: Coder,
 *   from: Node,
 *   run: [
 *     "git clone https://github.com/alchemy-run/alchemy /work",
 *     "cd /work && corepack enable && pnpm install",
 *   ],
 * });
 * ```
 *
 * @resource
 * @product Image
 */
export const Image = declarable<Image>()(Resource<Image>("Modal.Image"));

export type Image = Resource<"Modal.Image", ImageProps, ImageAttributes, never, Providers>;

const idOf = <K extends string>(value: unknown, key: K): string | undefined =>
  typeof value === "object" && value !== null && key in value
    ? ((value as Record<K, unknown>)[key] as string | undefined)
    : undefined;

/** The build spec for an Image's props (Dockerfile lowered, context collected). */
/**
 * Plan an Image's build with the shared {@link BuildPlan}: its environment
 * (`image`, `dockerfile`/`context`, or a Modal base via `from`) checked
 * against what Modal's builder runs, then the `commands` appended.
 */
const planOf = Effect.fn(function* (news: ImageProps) {
  const fromId = idOf(news.from, "imageId");
  const source =
    fromId !== undefined
      ? { dockerfile: { content: "FROM base\n" } }
      : news.dockerfile !== undefined || news.context !== undefined
        ? { dockerfile: news.dockerfile, context: news.context }
        : { image: news.image ?? "debian:bookworm-slim" };
  const plan = yield* BuildPlan.plan(source, { capabilities: MODAL_CAPABILITIES });
  const extra = yield* checkCommands(news.commands ?? []);
  const lowered = yield* lowerPlan(plan, extra);
  const spec: ImageBuildSpec = {
    ...lowered,
    // `FROM base` names the Modal image passed as a base image.
    ...(fromId !== undefined ? { baseImageId: fromId, commands: lowered.commands.slice(1) } : {}),
    secretIds: (news.secrets ?? []).flatMap((s) => idOf(s, "secretId") ?? []),
    registry: news.registry
      ? { authType: news.registry.type, secretId: idOf(news.registry.secret, "secretId") ?? "" }
      : undefined,
    gpu: news.gpu,
    builderVersion: news.builderVersion,
  };
  const hash = yield* sha256Object({
    plan: plan.hash,
    from: fromId,
    extra,
    secrets: spec.secretIds,
    registry: spec.registry,
    gpu: spec.gpu,
    builder: spec.builderVersion,
    // `tag` and `run` happen after the build; part of the hash so a change re-runs reconcile.
    tag: news.tag,
    run: news.run,
  });
  return { spec, hash, warnings: plan.warnings };
});

export const ImageProvider = () =>
  Provider.effect(
    Image,
    Effect.gen(function* () {
      return {
        stables: [],
        diff: Effect.fn(function* ({ news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          // A changed build input (including files under `context`) is a new image.
          const { hash } = yield* planOf(news);
          return hash !== output.hash ? ({ action: "update" } as const) : undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          if (output === undefined) return undefined;
          const found = yield* image
            .imageFromId({ imageId: output.imageId })
            .pipe(Effect.catchTag("ImageNotFound", () => Effect.undefined));
          return found?.imageId ? output : undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const appId = idOf(news.app, "appId") ?? "";
          const { spec, hash, warnings } = yield* planOf(news);
          for (const warning of warnings) yield* session.note(warning);
          // Observe: an image built from the same inputs still exists.
          if (output !== undefined && output.hash === hash && output.appId === appId) {
            const found = yield* image
              .imageFromId({ imageId: output.imageId })
              .pipe(Effect.catchTag("ImageNotFound", () => Effect.undefined));
            if (found?.imageId) return output;
          }
          // Ensure: Modal content-addresses builds, so this is a no-op for
          // inputs it has built before.
          let imageId = yield* buildImage(yield* ImageBuildOps, appId, spec, {
            note: session.note,
          });
          // Warm base: run setup in a sandbox and snapshot its filesystem.
          if (news.run && news.run.length > 0) {
            yield* session.note(`Running setup for image ${imageId}...`);
            const box = yield* createSandbox(
              yield* SandboxOps,
              { appId },
              {
                image: { imageId },
                secrets: spec.secretIds?.map((secretId) => ({ secretId })),
                timeout: "1 hour",
              },
            );
            const snapshot = yield* Effect.gen(function* () {
              for (const command of news.run ?? []) {
                const result = yield* box.exec(["sh", "-lc", command]);
                if (result.exitCode !== 0) {
                  return yield* new ImageSetupFailed({
                    command,
                    exitCode: result.exitCode,
                    message: `\`${command}\` exited ${result.exitCode}: ${result.stderr.slice(-2000)}`,
                  });
                }
              }
              return yield* box.snapshotFilesystem("5 minutes");
            }).pipe(Effect.ensuring(Effect.ignore(box.terminate())));
            imageId = snapshot.imageId;
          }
          if (news.tag !== undefined) {
            yield* image.publishImage({
              imageId,
              tag: news.tag,
              environmentName: idOf(news.app, "environment") ?? "",
            });
          }
          return {
            imageId,
            appId,
            appName: idOf(news.app, "name"),
            environment: idOf(news.app, "environment"),
            hash,
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* image
            .deleteImage({ imageId: output.imageId })
            .pipe(Effect.catchTag("ImageNotFound", () => Effect.void));
        }),
      };
    }),
  );
