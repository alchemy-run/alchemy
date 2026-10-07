/**
 * INTERNAL — the shared machinery behind every git mount binding
 * (`GitHub.MountRepository`, `Git.MountRepository`,
 * `Cloudflare.Artifacts.MountRepository`). Each public binding only knows
 * how to get its source's clone URL and credentials; this module turns them
 * into image layers and runtime git access. Not exported from `alchemy/FS`.
 */
import * as Crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { contextTarget } from "../Docker/ImageContext.ts";
import { bindIntoImageHost } from "../Docker/ImageHost.ts";
import type { ImageLayer } from "../Docker/ImageLayer.ts";
import type { Input } from "../Input.ts";
import type { ResourceLike } from "../Resource.ts";
import { unpackEnvValue } from "../RuntimeContext.ts";

/** Git credentials whose values may be Outputs (e.g. a minted token). */
export interface GitCredentialsInput {
  readonly username: Input<string>;
  readonly password: Input<Redacted.Redacted<string>>;
}

/**
 * What a mounted repository lets the processes in the container do with
 * git:
 *
 * - `"none"` — a snapshot: no credentials, `git push` disabled.
 * - `"read"` — `git fetch`/`pull` work; `git push` disabled.
 * - `"write"` — fetch and push.
 */
export type GitAccess = "none" | "read" | "write";

export interface MountGitOptions {
  /** Absolute path the repository is checked out at, e.g. `/workspace/app`. */
  readonly path: string;
  /** Branch, tag, or commit to check out. @default the repository's default branch */
  readonly ref?: string;
  /** Shallow history depth. @default full history */
  readonly depth?: number;
  /** Git access inside the container. @default "none" */
  readonly access?: GitAccess;
}

/** What a git mount returns: where the checkout lives. */
export interface MountedRepository {
  readonly path: string;
}

/** Git + CA certificates in the image (deduplicated with the harness installs). */
export const gitCliLayer: ImageLayer = {
  id: "git-cli",
  stage: "setup",
  instructions:
    "RUN if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends ca-certificates git && rm -rf /var/lib/apt/lists/*; elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates git; fi",
};

const CREDENTIAL_HELPER = `#!/bin/sh
# git credential helper: \`alchemy-git-credential <ENV_PREFIX> get\` answers
# with <ENV_PREFIX>_USERNAME / <ENV_PREFIX>_PASSWORD from the environment.
[ "$2" = "get" ] || exit 0
eval "u=\\\${$1_USERNAME:-}; p=\\\${$1_PASSWORD:-}"
[ -n "$p" ] || exit 0
echo "username=$u"
echo "password=$p"
`;

const credentialHelperLayer: ImageLayer = {
  id: "git-credential-helper",
  stage: "install",
  instructions: [
    `COPY ${contextTarget("git-credential-helper")} /usr/local/bin/alchemy-git-credential`,
    "RUN chmod +x /usr/local/bin/alchemy-git-credential",
  ].join("\n"),
  context: [
    {
      kind: "content",
      target: contextTarget("git-credential-helper"),
      content: CREDENTIAL_HELPER,
    },
  ],
};

const envPrefix = (path: string) =>
  `ALCHEMY_GIT_${Crypto.createHash("sha256").update(path).digest("hex").slice(0, 12).toUpperCase()}`;

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Mount a git repository at an absolute path in the host's image, with the
 * given access. `credentials` authenticate the build-time fetch;
 * `runtimeCredentials` (when access is not `"none"`) are bound into the
 * container's environment for the git CLI.
 */
export const mountGitRepository = (options: {
  /** Binding key, unique per mount (e.g. `GitHub.MountRepository`). */
  readonly kind: string;
  /** The repository resource whose Outputs the URL/credentials reference. */
  readonly resource?: ResourceLike;
  /** Clone URL; may be an Output of the repository resource. */
  readonly url: Input<string>;
  readonly credentials?: GitCredentialsInput;
  readonly runtimeCredentials?: GitCredentialsInput;
  readonly mount: MountGitOptions;
}): Effect.Effect<MountedRepository> =>
  Effect.gen(function* () {
    const { mount } = options;
    if (!mount.path.startsWith("/")) {
      return yield* Effect.die(
        new Error(`${options.kind}: path must be absolute, got ${mount.path}`),
      );
    }
    const access = mount.access ?? "none";
    const prefix = envPrefix(mount.path);
    if (globalThis.__ALCHEMY_RUNTIME__) {
      // Bound env values travel packed; the git CLI reads raw env.
      if (access !== "none") {
        for (const key of [`${prefix}_USERNAME`, `${prefix}_PASSWORD`]) {
          const value = unpackEnvValue<unknown>(process.env[key]);
          if (value === undefined) continue;
          process.env[key] = Redacted.isRedacted(value)
            ? String(Redacted.value(value))
            : String(value);
        }
      }
      return { path: mount.path };
    }
    if (access !== "none" && !options.runtimeCredentials) {
      return yield* Effect.die(
        new Error(`${options.kind}: access "${access}" needs credentials for ${mount.path}`),
      );
    }
    const target = contextTarget(`git:${mount.path}`);
    const ref = mount.ref;
    const path = shellQuote(mount.path);
    const setup = [
      `git config --system --add safe.directory ${path}`,
      // Read-only mounts keep fetch working but refuse to push.
      ...(access === "write" ? [] : [`git -C ${path} remote set-url --push origin DISABLED`]),
      ...(access === "none"
        ? []
        : [
            // Scoped to this checkout's own config: no URL needed here (it
            // may still be an unresolved Output at plan time).
            `git -C ${path} config credential.helper ${shellQuote(`/usr/local/bin/alchemy-git-credential ${prefix}`)}`,
          ]),
    ];
    const layer: Input<ImageLayer> = {
      id: `git-mount:${mount.path}`,
      stage: "source",
      instructions: [`COPY ${target}/ ${mount.path}/`, `RUN ${setup.join(" && ")}`].join("\n"),
      context: [
        {
          kind: "git",
          target,
          url: options.url,
          ...(ref ? { ref } : {}),
          ...(mount.depth !== undefined ? { depth: mount.depth } : {}),
          ...(options.credentials ? { credentials: options.credentials } : {}),
        },
      ],
    };
    yield* bindIntoImageHost(
      `${options.kind}:${mount.path}`,
      {
        image: [gitCliLayer, ...(access === "none" ? [] : [credentialHelperLayer]), layer],
        ...(access !== "none" && options.runtimeCredentials
          ? {
              env: {
                [`${prefix}_USERNAME`]: options.runtimeCredentials.username,
                [`${prefix}_PASSWORD`]: options.runtimeCredentials.password,
              },
            }
          : {}),
      },
      options.resource,
    );
    return { path: mount.path };
  });
