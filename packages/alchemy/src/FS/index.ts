/**
 * alchemy/FS — files and folders you mount into a container (or any image
 * host) at an absolute path.
 *
 * Declare what to mount at module scope (`FS.File`, `FS.Folder`), then
 * mount it inside the host's program. Git repositories mount through their
 * own source's binding: `GitHub.MountRepository`, `Git.MountRepository`,
 * `Cloudflare.Artifacts.MountRepository`.
 */
import * as Effect from "effect/Effect";
import { contextTarget } from "../Docker/ImageContext.ts";
import { bindIntoImageHost } from "../Docker/ImageHost.ts";

export type { GitAccess, MountGitOptions, MountedRepository } from "./GitMount.ts";

/** A file with inline content, mountable with {@link MountFile}. */
export interface File {
  readonly kind: "FS.File";
  readonly content: string;
  /** Unix permission bits, e.g. `0o755` for a script. @default 0o644 */
  readonly mode?: number;
}

/** A directory on the deploying machine, mountable with {@link MountFolder}. */
export interface Folder {
  readonly kind: "FS.Folder";
  /** Path on the deploying machine (relative to the current directory, or absolute). */
  readonly source: string;
}

export interface MountOptions {
  /** Absolute path in the host, e.g. `/etc/agent/settings.json`. */
  readonly path: string;
}

/**
 * A file with inline content. Never put secrets here — it is baked into the
 * image; bind secrets as environment instead.
 *
 * **Example:** A settings file
 * ```typescript
 * export const Settings = FS.File(JSON.stringify({ model: "haiku" }));
 * ```
 */
export const File = (content: string, options: { readonly mode?: number } = {}): File => ({
  kind: "FS.File",
  content,
  ...(options.mode !== undefined ? { mode: options.mode } : {}),
});

/**
 * A directory on the deploying machine, copied into the image when it is
 * built. Edits rebuild the image.
 *
 * **Example:** A folder of prompts
 * ```typescript
 * export const Prompts = FS.Folder("./prompts");
 * ```
 */
export const Folder = (source: string): Folder => ({ kind: "FS.Folder", source });

const assertAbsolute = (binding: string, path: string) =>
  path.startsWith("/")
    ? Effect.void
    : Effect.die(new Error(`${binding}: path must be absolute, got ${path}`));

/**
 * Mount a {@link File} at an absolute path in the image of the host it is
 * yielded in.
 *
 * ### Mounting a file
 * **Example:** A settings file in a container
 * ```typescript
 * export const Settings = FS.File(JSON.stringify({ model: "haiku" }));
 *
 * export default Sandbox.make(
 *   { main: import.meta.url, runtime: "node" },
 *   Effect.gen(function* () {
 *     yield* FS.MountFile(Settings, { path: "/etc/agent/settings.json" });
 *     // ...
 *   }),
 * );
 * ```
 *
 * @binding
 * @product FS
 * @category FS
 */
export const MountFile = (file: File, options: MountOptions): Effect.Effect<MountOptions> =>
  Effect.gen(function* () {
    yield* assertAbsolute("FS.MountFile", options.path);
    const target = contextTarget(`file:${options.path}`);
    const mode = (file.mode ?? 0o644).toString(8);
    yield* bindIntoImageHost(`FS.MountFile:${options.path}`, {
      image: [
        {
          id: `fs-file:${options.path}`,
          stage: "source",
          instructions: `COPY --chmod=${mode} ${target} ${options.path}`,
          context: [{ kind: "content", target, content: file.content }],
        },
      ],
    });
    return { path: options.path };
  });

/**
 * Mount a {@link Folder} from the deploying machine at an absolute path in
 * the image of the host it is yielded in.
 *
 * ### Mounting a folder
 * **Example:** Prompts next to the agent
 * ```typescript
 * export const Prompts = FS.Folder("./prompts");
 *
 * export default Sandbox.make(
 *   { main: import.meta.url, runtime: "node" },
 *   Effect.gen(function* () {
 *     yield* FS.MountFolder(Prompts, { path: "/home/agent/prompts" });
 *     // ...
 *   }),
 * );
 * ```
 *
 * @binding
 * @product FS
 * @category FS
 */
export const MountFolder = (folder: Folder, options: MountOptions): Effect.Effect<MountOptions> =>
  Effect.gen(function* () {
    yield* assertAbsolute("FS.MountFolder", options.path);
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const target = contextTarget(`folder:${options.path}`);
      const source = yield* Effect.sync(() =>
        folder.source.startsWith("/") ? folder.source : `${process.cwd()}/${folder.source}`,
      );
      yield* bindIntoImageHost(`FS.MountFolder:${options.path}`, {
        image: [
          {
            id: `fs-folder:${options.path}`,
            stage: "source",
            instructions: `COPY ${target}/ ${options.path}/`,
            context: [{ kind: "directory", target, source }],
          },
        ],
      });
    }
    return { path: options.path };
  });
