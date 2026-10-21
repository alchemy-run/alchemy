import { Docker } from "@alchemy.run/docker/Docker";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { sha256 } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { blockdBinaries } from "./VolumeBlockd.ts";

export interface VolumeImageProps {
  /** The volume's store, as blockd takes it: `s3://<bucket>/<prefix>`. */
  store: string;
  /** The store's S3 endpoint and credentials (R2's S3 API). */
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: Redacted.Redacted<string>;
  /** The volume's size in bytes. */
  size: number;
  /**
   * The filesystem the base is formatted with. A btrfs base keeps its files
   * in the subvolume `data`, the default, with `.alchemy/` beside it for
   * blockd's snapshots. @default "ext4"
   */
  filesystem?: "ext4" | "btrfs";
  /**
   * The base's files: a directory of an image built from `dockerfile`.
   * Omitted, the base is an empty filesystem.
   */
  base?: {
    dockerfile: string;
    /** The directory of the image that becomes the volume's root. @default "/workspace" */
    path?: string;
    /** @default "linux/amd64" */
    platform?: string;
  };
}

/**
 * The base image of a volume: an ext4 or btrfs filesystem built at deploy (empty, or
 * from a directory of a Docker image) and imported into the volume's store
 * as head `base-<hash>`. The head is named by the inputs' hash, so the base
 * is built once per change and never overwritten under running sessions.
 */
export type VolumeImage = Resource<
  "Cloudflare.R2.VolumeImage",
  VolumeImageProps,
  {
    /** The head sessions fork from. */
    head: string;
    hash: string;
  }
>;

export const VolumeImage = Resource<VolumeImage>("Cloudflare.R2.VolumeImage");

export class VolumeImageError extends Data.TaggedError("VolumeImageError")<{
  readonly message: string;
}> {}

/** Bump when the build changes in a way that must rebuild every base. */
const FORMAT = 1;

export const VolumeImageProvider = () =>
  Provider.effect(
    VolumeImage,
    Effect.gen(function* () {
      const docker = yield* Docker;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const run = Effect.fn(function* (what: string, args: Array<string>) {
        const result = yield* docker.run(args);
        if (result.exitCode !== 0) {
          return yield* new VolumeImageError({
            message: `${what} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
          });
        }
        return result.stdout;
      });

      const build = Effect.fn(function* (news: VolumeImageProps, head: string, hash: string) {
        const work = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-volume-" });
        const rootfs = path.join(work, "rootfs");
        yield* fs.makeDirectory(rootfs, { recursive: true });
        if (news.base) {
          const context = path.join(work, "context");
          yield* fs.makeDirectory(context, { recursive: true });
          yield* fs.writeFileString(path.join(context, "Dockerfile"), news.base.dockerfile);
          const tag = `alchemy-volume-base:${hash.slice(0, 16)}`;
          yield* run("building the base image", [
            "build",
            "--platform",
            news.base.platform ?? "linux/amd64",
            "-t",
            tag,
            context,
          ]);
          const name = `alchemy-volume-${hash.slice(0, 16)}`;
          yield* docker.run(["rm", "-f", name]);
          yield* run("creating the base container", ["create", "--name", name, tag, "true"]);
          const copied = yield* Effect.exit(
            run("copying the base's files", [
              "cp",
              `${name}:${news.base.path ?? "/workspace"}/.`,
              rootfs,
            ]),
          );
          yield* docker.run(["rm", "-f", name]);
          if (copied._tag === "Failure") return yield* copied;
        }
        // Secrets go through an env file, never the command line.
        const envFile = path.join(work, "store.env");
        yield* fs.writeFileString(
          envFile,
          [
            `AWS_ACCESS_KEY_ID=${news.accessKeyId}`,
            `AWS_SECRET_ACCESS_KEY=${Redacted.value(news.secretAccessKey)}`,
            `AWS_ENDPOINT=${news.endpoint}`,
            "AWS_REGION=auto",
            `STORE=${news.store}`,
            `HEAD=${head}`,
          ].join("\n"),
        );
        const blockd = yield* blockdBinaries;
        const kib = Math.ceil(news.size / 1024);
        const btrfs = news.filesystem === "btrfs";
        const format = btrfs
          ? [
              // The workspace is the default subvolume `data`; blockd's snapshots go beside it.
              "mkdir -p /work/layout/.alchemy && mv /work/rootfs /work/layout/data",
              `truncate -s ${kib}k /work/base.img`,
              "mkfs.btrfs -q -f -s 4096 --rootdir /work/layout --subvol default:data /work/base.img >/dev/null",
            ]
          : [`mkfs.ext4 -q -F -b 4096 -d /work/rootfs /work/base.img ${kib}k`];
        const script = [
          "set -e",
          // btrfs-progs 6.11+ for --subvol: Debian trixie.
          `apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends ca-certificates ${btrfs ? "btrfs-progs" : "e2fsprogs"} >/dev/null`,
          ...format,
          'bin="/blockd/blockd-$(uname -m)"',
          // Already imported (an earlier deploy): the head exists and is the same build.
          '"$bin" heads --store "$STORE" | grep -q "^$HEAD " || "$bin" import --store "$STORE" --head "$HEAD" --image /work/base.img',
        ].join("\n");
        yield* run("importing the base into the store", [
          "run",
          "--rm",
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
      }, Effect.scoped);

      return {
        stables: ["head", "hash"],
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const hash = yield* sha256(
            JSON.stringify({
              FORMAT,
              size: news.size,
              base: news.base ?? null,
              store: news.store,
              // Absent for ext4, so existing bases keep their hash.
              ...(news.filesystem && news.filesystem !== "ext4"
                ? { filesystem: news.filesystem }
                : {}),
            }),
          );
          const head = `base-${hash.slice(0, 16)}`;
          if (output?.hash === hash) return output;
          yield* session.note(`Building the volume's base (${head})…`);
          yield* build(news, head, hash);
          return { head, hash };
        }),
        // The base stays: sessions forked from it reference its snapshot.
        // Garbage collection reclaims it once no head does.
        delete: Effect.fn(function* () {}),
      };
    }),
  );
