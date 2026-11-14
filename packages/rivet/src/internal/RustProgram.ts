/**
 * Rust node programs: an external `Rivet.DurableObject` given a `crate`.
 * The crate (or the Cargo workspace it belongs to) is staged with a
 * generated Dockerfile that compiles its binary and runs it as the node, so
 * any pool whose compute builds images from a Dockerfile can host it.
 *
 * @internal
 */
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** How a Rust Durable Object's crate is compiled into its node image. */
export interface CargoBuild {
  /**
   * The Rust toolchain: a tag of the official `rust` image, such as `1.85`.
   * @default "1" (the latest stable release)
   */
  toolchain?: string;
  /** Cargo features to enable (`--features`). */
  features?: string[];
  /**
   * Leave out the crate's default features (`--no-default-features`).
   * @default false
   */
  noDefaultFeatures?: boolean;
  /**
   * The Cargo profile to build with (`--profile`).
   * @default "release"
   */
  profile?: string;
  /**
   * The binary the nodes run (`--bin`).
   * @default the package's own binary, or its only `[[bin]]`
   */
  bin?: string;
  /**
   * Debian packages the build needs, installed for the build machine
   * before compiling, such as `protobuf-compiler` or `cmake`.
   */
  packages?: string[];
  /**
   * Debian packages the binary needs at run time, installed in the node
   * image, such as `libssl3`.
   */
  runtimePackages?: string[];
}

/** A Rust Durable Object's `crate` is not a crate Alchemy can build. */
export class InvalidRustCrate extends Data.TaggedError("Rivet.InvalidRustCrate")<{
  readonly message: string;
}> {}

/** Where a Rust node binary lives in its image. */
export const RUST_NODE_BINARY = "/usr/local/bin/rivet-node";

/** Paths left out of the staged crate: build output and VCS metadata. */
const SKIPPED = new Set(["target", ".git", "node_modules", ".alchemy"]);

/** The directory Cargo writes a profile's output to. */
const profileDirectory = (profile: string) =>
  profile === "dev" || profile === "test" ? "debug" : profile === "bench" ? "release" : profile;

/** Quote a value for a POSIX shell. */
const shell = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The node image. Dependencies compile in a layer of their own, keyed by
 * cargo-chef's recipe of the manifests, so a change to the crate's code
 * rebuilds only the crate. The compiler runs on the build machine's own
 * platform, cross-compiling when the image targets another architecture
 * (an Apple silicon laptop building `linux/amd64` nodes, and the reverse),
 * so it never runs under emulation. The binary runs on a slim Debian with
 * CA roots, as RivetKit connects to the control plane over TLS.
 */
export const rustDockerfile = (options: {
  readonly binary: string;
  /** The package, when the context is the workspace it belongs to. */
  readonly workspacePackage: string | undefined;
  readonly build: CargoBuild;
}) => {
  const { binary, workspacePackage, build } = options;
  const profile = build.profile ?? "release";
  const flags = [
    `--profile ${shell(profile)}`,
    ...(workspacePackage === undefined ? [] : [`-p ${shell(workspacePackage)}`]),
    ...(build.features?.length ? [`--features ${shell(build.features.join(","))}`] : []),
    ...(build.noDefaultFeatures ? ["--no-default-features"] : []),
    `--bin ${shell(binary)}`,
  ].join(" ");
  const packages = (build.packages ?? []).map(shell).join(" ");
  const runtimePackages = ["ca-certificates", ...(build.runtimePackages ?? [])]
    .map(shell)
    .join(" ");
  return `# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM rust:${build.toolchain ?? "1"}-bookworm AS chef
ARG TARGETARCH
WORKDIR /src
RUN set -eu; \\
  case "$TARGETARCH" in \\
    amd64) triple=x86_64-unknown-linux-gnu; pkg=x86-64-linux-gnu; gcc=x86_64-linux-gnu ;; \\
    arm64) triple=aarch64-unknown-linux-gnu; pkg=aarch64-linux-gnu; gcc=aarch64-linux-gnu ;; \\
    *) echo "Rivet Rust nodes build for amd64 or arm64, not $TARGETARCH" >&2; exit 1 ;; \\
  esac; \\
  echo "$triple" > /triple; \\
  touch /cross.env; \\
  extra=""; \\
  if [ "$(rustc -vV | sed -n 's/^host: //p')" != "$triple" ]; then \\
    extra="gcc-$pkg libc6-dev-$TARGETARCH-cross"; \\
    rustup target add "$triple"; \\
    printf '[target.%s]\\nlinker = "%s-gcc"\\n' "$triple" "$gcc" >> /usr/local/cargo/config.toml; \\
    echo "CC_$(echo "$triple" | tr - _)=$gcc-gcc" > /cross.env; \\
  fi; \\
  if [ -n "$extra${packages === "" ? "" : "x"}" ]; then \\
    apt-get update && apt-get install -y --no-install-recommends $extra ${packages}; \\
  fi; \\
  cargo install cargo-chef --locked

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path /recipe.json

FROM chef AS build
COPY --from=planner /recipe.json /recipe.json
RUN set -eu; export $(cat /cross.env); \\
  cargo chef cook --recipe-path /recipe.json --target "$(cat /triple)" ${flags}
COPY . .
RUN set -eu; export $(cat /cross.env); triple=$(cat /triple); \\
  cargo build --target "$triple" ${flags}; \\
  cp "target/$triple/${profileDirectory(profile)}/${binary}" /rivet-node

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ${runtimePackages} && rm -rf /var/lib/apt/lists/*
COPY --from=build /rivet-node ${RUST_NODE_BINARY}
# Hosts that bake the environment into the image write it to /etc/rivet-env.
CMD ["/bin/sh", "-c", "if [ -f /etc/rivet-env ]; then set -a; . /etc/rivet-env; set +a; fi; exec ${RUST_NODE_BINARY}"]
`;
};

/** A TOML section's `name = "..."`. */
const nameIn = (section: string | undefined) =>
  section?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];

const sectionsOf = (manifest: string) => manifest.split(/^\s*\[/m);

/** The `[package]` name of a manifest. */
export const rustPackageName = (manifest: string) =>
  nameIn(sectionsOf(manifest).find((section) => section.startsWith("package]")));

/**
 * The binary a crate's node runs: its package's own binary, unless the
 * manifest declares exactly one `[[bin]]` under another name.
 */
export const rustBinaryName = (manifest: string): string | undefined => {
  const pkg = rustPackageName(manifest);
  const bins = sectionsOf(manifest)
    .filter((section) => section.startsWith("[bin]]"))
    .map(nameIn)
    .filter((name): name is string => name !== undefined);
  if (bins.length === 1 && bins[0] !== pkg) return bins[0];
  return pkg;
};

const isWorkspaceManifest = (manifest: string) => /^\s*\[workspace\]/m.test(manifest);

/**
 * Stage the crate beside its generated Dockerfile into a directory of its
 * own, named `label`, and resolve to the build context every host builds
 * the node image from. A crate that belongs to a Cargo workspace (the
 * nearest `Cargo.toml` above it with a `[workspace]`) is staged with the
 * whole workspace and built with `-p`, as Cargo would build it.
 */
export const stageRustProgram = Effect.fn(function* (
  label: string,
  crate: string,
  build: CargoBuild = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crateDir = path.basename(crate) === "Cargo.toml" ? path.dirname(crate) : crate;
  const manifestPath = path.join(crateDir, "Cargo.toml");
  const manifest = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError(
        () => new InvalidRustCrate({ message: `Cannot read the crate manifest ${manifestPath}.` }),
      ),
    );
  const pkg = rustPackageName(manifest);
  const binary = build.bin ?? rustBinaryName(manifest);
  if (pkg === undefined || binary === undefined) {
    return yield* new InvalidRustCrate({
      message: `${manifestPath} has no [package] name, so it has no binary to run.`,
    });
  }

  // The workspace the crate belongs to, if any: its own manifest, or the
  // nearest one above it.
  let root = crateDir;
  let workspace = isWorkspaceManifest(manifest);
  if (!workspace) {
    let dir = path.dirname(crateDir);
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, "Cargo.toml");
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        const text = yield* fs.readFileString(candidate).pipe(Effect.orElseSucceed(() => ""));
        if (isWorkspaceManifest(text)) {
          root = dir;
          workspace = true;
          break;
        }
      }
      dir = path.dirname(dir);
    }
  }

  const dir = path.resolve(yield* dotAlchemyDirectory, "rivet", "rust", label);
  const copy = (from: string, to: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(to, { recursive: true });
      for (const entry of yield* fs.readDirectory(from)) {
        if (SKIPPED.has(entry)) continue;
        const source = path.join(from, entry);
        const target = path.join(to, entry);
        const info = yield* fs.stat(source);
        if (info.type === "Directory") yield* copy(source, target);
        else if (info.type === "File") yield* fs.copyFile(source, target);
      }
    });

  yield* fs.remove(dir, { recursive: true, force: true }).pipe(Effect.orDie);
  yield* copy(root, dir).pipe(Effect.orDie);
  yield* fs
    .writeFileString(
      path.join(dir, "Dockerfile"),
      rustDockerfile({ binary, workspacePackage: workspace ? pkg : undefined, build }),
    )
    .pipe(Effect.orDie);
  return { context: dir, dockerfile: path.join(dir, "Dockerfile") };
});
