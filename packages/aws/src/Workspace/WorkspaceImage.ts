import { Docker } from "@alchemy.run/docker/Docker";
import { blockdBinaries } from "@alchemy.run/sandbox/Blockd";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { sha256 } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { AWSEnvironment } from "../Environment.ts";

export interface WorkspaceImageProps {
  /** The store: `s3://<bucket>/<prefix>`. */
  store: string;
  /** The image: its whole root is what commands run on. */
  dockerfile: string;
  /** The directory of the image that is a new session's workspace. @default "/workspace" */
  path?: string;
  /** `linux/arm64` or `linux/amd64`: the hosts' architecture. */
  platform: "linux/arm64" | "linux/amd64";
  /** The workspace's size in bytes. */
  size: number;
  /** @default "ext4" */
  filesystem?: "ext4" | "btrfs";
  /** Where blockd's binaries go in the store's bucket. */
  binaries: string;
}

/**
 * What every host of an `AWS.Workspace` needs from the store, built at
 * deploy from the workspace's Dockerfile: the image commands run on (its
 * whole root, as a volume), the base a new session forks from (its
 * workspace directory, as a volume), and blockd's binaries. Volumes are
 * named by the inputs' hash: built once per change, never overwritten under
 * running sessions.
 *
 * @internal
 */
export type WorkspaceImage = Resource<
  "AWS.Workspace.Image",
  WorkspaceImageProps,
  {
    /** The image's snapshot. */
    image: string;
    /** The head new sessions fork from. */
    base: string;
    hash: string;
  }
>;

export const WorkspaceImage = Resource<WorkspaceImage>("AWS.Workspace.Image");

export class WorkspaceImageError extends Data.TaggedError("WorkspaceImageError")<{
  readonly message: string;
}> {}

/** Bump when the build changes in a way that must rebuild every image. */
const FORMAT = 1;

export const WorkspaceImageProvider = () =>
  Provider.effect(
    WorkspaceImage,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const run = Effect.fn(function* (what: string, args: Array<string>) {
        const result = yield* docker.run(args);
        if (result.exitCode !== 0) {
          return yield* new WorkspaceImageError({
            message: `${what} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
          });
        }
        return result.stdout;
      });

      const build = Effect.fn(function* (news: WorkspaceImageProps, hash: string) {
        const work = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-workspace-" });
        const context = path.join(work, "context");
        yield* fs.makeDirectory(context, { recursive: true });
        yield* fs.writeFileString(path.join(context, "Dockerfile"), news.dockerfile);
        const tag = `alchemy-workspace:${hash.slice(0, 16)}`;
        yield* run("building the image", [
          "build",
          "--platform",
          news.platform,
          "-t",
          tag,
          context,
        ]);
        const name = `alchemy-workspace-${hash.slice(0, 16)}`;
        yield* docker.run(["rm", "-f", name]);
        yield* run("creating the image's container", [
          "create",
          "--platform",
          news.platform,
          "--name",
          name,
          tag,
          "true",
        ]);
        const base = path.join(work, "base");
        yield* fs.makeDirectory(base, { recursive: true });
        const copied = yield* Effect.exit(
          Effect.gen(function* () {
            // The whole root, as a tar (ownership and modes kept), and the workspace.
            yield* run("exporting the image's root", [
              "export",
              "-o",
              path.join(work, "rootfs.tar"),
              name,
            ]);
            yield* run("copying the workspace", [
              "cp",
              `${name}:${news.path ?? "/workspace"}/.`,
              base,
            ]);
          }),
        );
        yield* docker.run(["rm", "-f", name]);
        if (copied._tag === "Failure") return yield* Effect.failCause(copied.cause);

        const credentials = yield* yield* Credentials.Credentials;
        const { region } = yield* AWSEnvironment.current;
        // Secrets go through an env file, never the command line.
        const envFile = path.join(work, "store.env");
        yield* fs.writeFileString(
          envFile,
          [
            `AWS_ACCESS_KEY_ID=${Redacted.value(credentials.accessKeyId)}`,
            `AWS_SECRET_ACCESS_KEY=${Redacted.value(credentials.secretAccessKey)}`,
            ...(credentials.sessionToken
              ? [`AWS_SESSION_TOKEN=${Redacted.value(credentials.sessionToken)}`]
              : []),
            `AWS_REGION=${region}`,
            `STORE=${news.store}`,
            `IMAGE=image-${hash.slice(0, 16)}`,
            `BASE=base-${hash.slice(0, 16)}`,
            `BINARIES=${news.binaries}`,
          ].join("\n"),
        );
        const blockd = yield* blockdBinaries;
        const kib = Math.ceil(news.size / 1024);
        const btrfs = news.filesystem === "btrfs";
        const formatBase = btrfs
          ? [
              "mkdir -p /work/layout/.alchemy && mv /work/base /work/layout/data",
              `truncate -s ${kib}k /work/base.img`,
              "mkfs.btrfs -q -f -s 4096 --rootdir /work/layout --subvol default:data /work/base.img >/dev/null",
            ]
          : [`mkfs.ext4 -q -F -b 4096 -d /work/base /work/base.img ${kib}k`];
        const script = [
          "set -e",
          `apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends ca-certificates e2fsprogs ${btrfs ? "btrfs-progs" : ""} >/dev/null`,
          'bin="/blockd/blockd-$(uname -m)"',
          // The image: its root, with room to spare, as ext4 (read-only to every container).
          // Extracted inside the container: a bind mount from the deploying
          // machine (macOS) doesn't keep a root's ownership and links.
          "mkdir -p /rootfs && tar -xf /work/rootfs.tar -C /rootfs --numeric-owner",
          "size=$(( $(du -sk /rootfs | cut -f1) * 13 / 10 + 65536 ))",
          'mkfs.ext4 -q -F -b 4096 -d /rootfs /work/image.img "${size}k"',
          '"$bin" heads --store "$STORE" | grep -q "^$IMAGE " || "$bin" import --store "$STORE" --head "$IMAGE" --image /work/image.img',
          ...formatBase,
          '"$bin" heads --store "$STORE" | grep -q "^$BASE " || "$bin" import --store "$STORE" --head "$BASE" --image /work/base.img',
          // The hosts' blockd: the daemon (glibc, ublk) and a static one for containers' init.
          "bucket=${STORE#s3://}; bucket=${bucket%%/*}",
          'for f in /blockd/blockd-*; do "$bin" blob-put --store "s3://$bucket/$BINARIES" --key "$(basename "$f")" --file "$f"; done',
          '"$bin" history --store "$STORE" --head "$IMAGE" --limit 1',
        ].join("\n");
        const image = yield* run("importing the image and base into the store", [
          "run",
          "--rm",
          "--platform",
          news.platform,
          "--env-file",
          envFile,
          "-v",
          `${work}:/work`,
          "-v",
          `${blockd}:/blockd:ro`,
          btrfs ? "debian:trixie-slim" : "debian:bookworm-slim",
          "sh",
          "-c",
          script,
        ]);
        return image.trim().split("\n").pop()!.trim();
      }, Effect.scoped);

      return {
        stables: ["hash"],
        reconcile: Effect.fn(function* ({ news, output, session }) {
          // A new blockd is a new build: the hosts install what the store has.
          const binaries = yield* blockdBinaries;
          const builds: Record<string, string> = {};
          for (const file of (yield* fs.readDirectory(binaries)).sort()) {
            if (file.startsWith("blockd-")) {
              builds[file] = yield* sha256(yield* fs.readFile(path.join(binaries, file)));
            }
          }
          const hash = yield* sha256(
            JSON.stringify({
              builds,
              FORMAT,
              dockerfile: news.dockerfile,
              path: news.path ?? "/workspace",
              platform: news.platform,
              size: news.size,
              filesystem: news.filesystem ?? "ext4",
              store: news.store,
              binaries: news.binaries,
            }),
          );
          if (output?.hash === hash) return output;
          yield* session.note(`Building the workspace's image (${hash.slice(0, 16)})…`);
          const image = yield* build(news, hash);
          return { image, base: `base-${hash.slice(0, 16)}`, hash };
        }),
        // The volumes stay: sessions forked from them reference their snapshots.
        delete: Effect.fn(function* () {}),
      };
    }),
  );
