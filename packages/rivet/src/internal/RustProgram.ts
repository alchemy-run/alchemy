/**
 * Rust node programs: an external `Rivet.DurableObject` whose `main` is a
 * crate's `Cargo.toml`. The crate is staged with a generated Dockerfile
 * that compiles its binary and runs it as the node, so any pool whose
 * compute builds images from a Dockerfile can host it.
 *
 * @internal
 */
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** A Rust Durable Object's `main` is not a crate Alchemy can build. */
export class InvalidRustCrate extends Data.TaggedError("Rivet.InvalidRustCrate")<{
  readonly message: string;
}> {}

/** Whether `main` names a crate manifest rather than a JavaScript entry. */
export const isRustManifest = (main: string) => /(^|[\\/])Cargo\.toml$/.test(main);

/** Where a Rust node binary lives in its image. */
export const RUST_NODE_BINARY = "/usr/local/bin/rivet-node";

/** Paths left out of the staged crate: build output and VCS metadata. */
const SKIPPED = new Set(["target", ".git", "node_modules", ".alchemy"]);

/**
 * The node image: the crate compiled on the build machine's own platform,
 * cross-compiled when the image targets another architecture (an Apple
 * silicon laptop building `linux/amd64` nodes, and the reverse), so builds
 * never run the compiler under emulation. The binary runs on a slim Debian
 * with CA roots, as RivetKit connects to the control plane over TLS.
 */
export const rustDockerfile = (binary: string) => `# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM rust:1-bookworm AS build
ARG TARGETARCH
WORKDIR /src
RUN set -eu; \\
  case "$TARGETARCH" in \\
    amd64) triple=x86_64-unknown-linux-gnu; pkg=x86-64-linux-gnu; gcc=x86_64-linux-gnu ;; \\
    arm64) triple=aarch64-unknown-linux-gnu; pkg=aarch64-linux-gnu; gcc=aarch64-linux-gnu ;; \\
    *) echo "Rivet Rust nodes build for amd64 or arm64, not $TARGETARCH" >&2; exit 1 ;; \\
  esac; \\
  echo "$triple" > /triple; \\
  if [ "$(rustc -vV | sed -n 's/^host: //p')" != "$triple" ]; then \\
    apt-get update && apt-get install -y --no-install-recommends gcc-$pkg libc6-dev-$TARGETARCH-cross; \\
    rustup target add "$triple"; \\
    printf '[target.%s]\\nlinker = "%s-gcc"\\n' "$triple" "$gcc" >> /usr/local/cargo/config.toml; \\
    echo "CC_$(echo "$triple" | tr - _)=$gcc-gcc" > /cross.env; \\
  fi
COPY . .
RUN set -eu; triple=$(cat /triple); \\
  if [ -f /cross.env ]; then export $(cat /cross.env); fi; \\
  cargo build --release --target "$triple" --bin ${binary}; \\
  cp "target/$triple/release/${binary}" /rivet-node
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /rivet-node ${RUST_NODE_BINARY}
# Hosts that bake the environment into the image write it to /etc/rivet-env.
CMD ["/bin/sh", "-c", "if [ -f /etc/rivet-env ]; then set -a; . /etc/rivet-env; set +a; fi; exec ${RUST_NODE_BINARY}"]
`;

/**
 * The binary a crate's node runs: its package's own binary, unless the
 * manifest declares exactly one `[[bin]]` under another name.
 */
export const rustBinaryName = (manifest: string): string | undefined => {
  const sections = manifest.split(/^\s*\[/m);
  const nameIn = (section: string | undefined) =>
    section?.match(/^\s*name\s*=\s*["']([^"']+)["']/m)?.[1];
  const pkg = nameIn(sections.find((section) => section.startsWith("package]")));
  const bins = sections
    .filter((section) => section.startsWith("[bin]]"))
    .map(nameIn)
    .filter((name): name is string => name !== undefined);
  if (bins.length === 1 && bins[0] !== pkg) return bins[0];
  return pkg;
};

/**
 * Copy the crate beside its generated Dockerfile into a directory of its
 * own, named `label`, and resolve to that directory: the build context
 * every host builds the node image from.
 */
export const stageRustProgram = Effect.fn(function* (label: string, manifestPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError(
        () => new InvalidRustCrate({ message: `Cannot read the crate manifest ${manifestPath}.` }),
      ),
    );
  const binary = rustBinaryName(manifest);
  if (binary === undefined) {
    return yield* new InvalidRustCrate({
      message: `${manifestPath} has no [package] name, so it has no binary to run.`,
    });
  }
  const crate = path.dirname(manifestPath);
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
  yield* copy(crate, dir).pipe(Effect.orDie);
  yield* fs
    .writeFileString(path.join(dir, "Dockerfile"), rustDockerfile(binary))
    .pipe(Effect.orDie);
  return { context: dir, dockerfile: path.join(dir, "Dockerfile") };
});
