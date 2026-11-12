import { createHash } from "node:crypto";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";
import {
  type CloudAuth,
  completeBuild,
  createBuild,
  deleteBuild,
  deleteRunnerPool,
  getBuild,
  getRunnerPool,
  listBuilds,
  listRegions,
  putRunnerPool,
  RivetCloudApiError,
  type RunnerPoolInfo,
  uploadBuild,
} from "./Api.ts";
import { Credentials } from "./Credentials.ts";

/** The machine types a Rivet Cloud runner pool can run. */
export type RunnerMachineType =
  | "e2-micro"
  | "e2-small"
  | "e2-medium"
  | "e2-custom-4-8192"
  | "e2-custom-8-16384";

export interface RunnerPoolProps {
  /** The cluster's name. */
  cluster: string;
  /**
   * The region the pool runs in. It must be enabled on the cluster.
   * @default the cluster's first region
   */
  region?: string;
  /**
   * The runner pool's name. Rivet Cloud supports only `default` for now, so a
   * cluster runs one runner pool. Its nodes join the control-plane pool named
   * by `RIVET_POOL` in {@link env}. Immutable.
   * @default "default"
   */
  name?: string;
  /**
   * The bundled node program, a single ES module run with Bun. Set this or
   * {@link context}.
   */
  main?: string;
  /** The RivetKit release installed beside {@link main}. */
  rivetkitVersion?: string;
  /**
   * A node program that is an image of its own: a directory whose
   * `Dockerfile` builds it for `linux/amd64`. Its start command sources
   * `/etc/rivet-env`, where {@link env} is written. Set this or {@link main}.
   */
  context?: string;
  /**
   * Environment baked into the image. Rivet Cloud runner pools take no
   * environment of their own, so every value here, secrets included, is in
   * the image Rivet stores.
   */
  env: Record<string, string>;
  /**
   * The machine each node runs on. The cluster's plan caps it.
   * @default "e2-small"
   */
  machineType?: RunnerMachineType;
  /**
   * The number of nodes. The cluster's plan caps it across all its pools.
   * @default 1
   */
  nodeCount?: number;
}

export interface RunnerPool extends Resource<
  "RivetCloud.RunnerPool",
  RunnerPoolProps,
  {
    /** The pool's name. */
    name: string;
    /** The cluster the pool belongs to. */
    cluster: string;
    /** The region the pool runs in. */
    region: string;
    /** The build the pool runs. */
    buildId: string;
    /** A digest of the image the build was made from. */
    digest: string;
  },
  never,
  Providers
> {}

/**
 * Nodes Rivet Cloud runs for you: a runner pool on a Rivet Cloud cluster,
 * booted from a Docker image of the node program. Each deploy whose program
 * or environment changed builds the image with the local `docker` CLI,
 * uploads it as a build, and rolls the pool out to it.
 *
 * `RivetCloud.Pool` declares one for its Durable Objects; declare this
 * directly only to run a node program of your own.
 *
 * ### Running nodes on Rivet Cloud
 * **Example:** A runner pool for a bundled node program
 * ```typescript
 * const pool = yield* RivetCloud.RunnerPool("Default", {
 *   cluster: "acme",
 *   main: "./dist/node.mjs",
 *   rivetkitVersion: "3.0.0",
 *   env: { RIVET_NAMESPACE: "acme-prod", RIVET_POOL: "acme-prod-default" },
 * });
 * ```
 *
 * @resource
 */
export const RunnerPool = Resource<RunnerPool>("RivetCloud.RunnerPool");

/** A build failed, expired or was deleted before it was ready. */
export class RunnerBuildFailed extends Data.TaggedError("RivetCloud.RunnerBuildFailed")<{
  readonly message: string;
}> {}

/** A runner pool failed to roll out its build. */
export class RunnerPoolRolloutFailed extends Data.TaggedError(
  "RivetCloud.RunnerPoolRolloutFailed",
)<{
  readonly message: string;
}> {}

/** The cluster has no region to run a pool in. */
export class NoClusterRegion extends Data.TaggedError("RivetCloud.NoClusterRegion")<{
  readonly message: string;
}> {}

/** Still waiting: a build or a rollout that has not finished. */
class Pending extends Data.TaggedError("RivetCloud.Pending")<{ readonly message: string }> {}

/** The node image: Bun with RivetKit, the node program, and its environment. */
const dockerfile = (rivetkitVersion: string) => `FROM --platform=linux/amd64 oven/bun:1
WORKDIR /app
RUN bun add rivetkit@${rivetkitVersion}
COPY node.mjs env.json start.mjs ./
CMD ["bun", "start.mjs"]
`;

/** The environment, as a POSIX shell file an image's start command sources. */
const envFile = (env: Record<string, string>) =>
  Object.keys(env)
    .sort()
    .map((name) => `${name}='${String(env[name]).replaceAll("'", `'\\''`)}'\n`)
    .join("");

/** Load the baked environment, then start the node program. */
const START = `import env from "./env.json" with { type: "json" };
Object.assign(process.env, env);
await import("./node.mjs");
`;

const nameOf = (props: RunnerPoolProps) => props.name ?? "default";
/** The image repository every build of a pool is tagged in. */
const imageRepository = (cluster: string, pool: string) => `rivet-${cluster}-${pool}`;
const machineTypeOf = (props: RunnerPoolProps) => props.machineType ?? "e2-small";
const nodeCountOf = (props: RunnerPoolProps) => props.nodeCount ?? 1;

export const RunnerPoolProvider = () =>
  Provider.effect(
    RunnerPool,
    Effect.gen(function* () {
      const credentials = yield* Credentials;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      /** Run the `docker` CLI and fail with its output when it exits non-zero. */
      const docker = Effect.fn("RivetCloud.docker")(function* (args: Array<string>) {
        const child = yield* spawner.spawn(
          ChildProcess.make("docker", args, {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            extendEnv: true,
          }),
        );
        const [exitCode, stdout, stderr] = yield* Effect.all(
          [
            child.exitCode,
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new RivetCloudApiError({
            message: `docker ${args[0]} exited with ${exitCode}: ${(stderr || stdout).trim().slice(-800)}`,
          });
        }
        return stdout.trim();
      }, Effect.scoped);

      /** Every file under `dir`, keyed by its path relative to it. */
      const readTree = (
        dir: string,
        prefix = "",
      ): Effect.Effect<Record<string, Uint8Array>, unknown> =>
        Effect.gen(function* () {
          const files: Record<string, Uint8Array> = {};
          for (const entry of (yield* fs.readDirectory(path.join(dir, prefix))).sort()) {
            const relative = prefix === "" ? entry : `${prefix}/${entry}`;
            const info = yield* fs.stat(path.join(dir, relative));
            if (info.type === "Directory") Object.assign(files, yield* readTree(dir, relative));
            else if (info.type === "File")
              files[relative] = yield* fs.readFile(path.join(dir, relative));
          }
          return files;
        });

      /** The files the image is built from, and a digest of them. */
      const imageFiles = Effect.fn(function* (props: RunnerPoolProps) {
        let files: Record<string, string | Uint8Array>;
        if (props.context !== undefined) {
          const tree = yield* readTree(props.context).pipe(
            Effect.mapError(
              (cause) =>
                new RivetCloudApiError({
                  message: `Cannot read ${props.context}: ${String(cause)}`,
                }),
            ),
          );
          const base =
            tree.Dockerfile === undefined ? "" : new TextDecoder().decode(tree.Dockerfile);
          files = {
            ...tree,
            Dockerfile: `${base}\nCOPY rivet-env /etc/rivet-env\n`,
            "rivet-env": envFile(props.env),
          };
        } else {
          files = {
            Dockerfile: dockerfile(props.rivetkitVersion ?? "3.0.0"),
            "node.mjs": yield* fs.readFileString(props.main ?? ""),
            "env.json": JSON.stringify(props.env, Object.keys(props.env).sort()),
            "start.mjs": START,
          };
        }
        const digest = yield* Effect.sync(() => {
          const hash = createHash("sha256");
          for (const name of Object.keys(files).sort())
            hash.update(name).update("\0").update(files[name]!);
          return hash.digest("hex");
        });
        return { files, digest };
      });

      /** The build for this image, uploaded unless one is on the cluster, once Rivet has it ready. */
      const uploadImage = Effect.fn(function* (
        props: RunnerPoolProps,
        files: Record<string, string | Uint8Array>,
        digest: string,
        note: (message: string) => Effect.Effect<void>,
      ) {
        const auth = yield* credentials;
        const image = `${imageRepository(props.cluster, nameOf(props))}:${digest.slice(0, 12)}`;
        // A deploy that failed after uploading left this image's build behind.
        const existing = (yield* listBuilds(auth, props.cluster)).find(
          (build) =>
            build.image === image && ["completing", "preparing", "ready"].includes(build.status),
        );
        const buildId = existing?.build_id ?? (yield* upload(props.cluster, image, files, note));
        yield* note(`Preparing build ${buildId}, which usually takes about 3 minutes...`);
        yield* waitForBuild(auth, props.cluster, buildId);
        return buildId;
      });

      /** Build the image with the docker CLI and upload it as a new build. */
      const upload = Effect.fn(function* (
        cluster: string,
        image: string,
        files: Record<string, string | Uint8Array>,
        note: (message: string) => Effect.Effect<void>,
      ) {
        const auth = yield* credentials;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "rivet-cloud-build-" });
        for (const [name, content] of Object.entries(files)) {
          const file = path.join(dir, name);
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          if (typeof content === "string") yield* fs.writeFileString(file, content);
          else yield* fs.writeFile(file, content);
        }
        yield* note(`Building image ${image}...`);
        yield* docker(["build", "--platform", "linux/amd64", "-t", image, dir]);
        const tarPath = path.join(dir, "image.tar");
        yield* docker(["image", "save", image, "-o", tarPath]);
        const tarball = yield* fs.readFile(tarPath);
        const md5 = yield* Effect.sync(() => createHash("md5").update(tarball).digest("base64"));
        const build = yield* createBuild(auth, cluster, {
          image,
          content_length: tarball.byteLength,
          content_md5: md5,
        });
        yield* note(
          `Uploading build ${build.build_id} (${Math.round(tarball.byteLength / 1e6)} MB)...`,
        );
        yield* uploadBuild(build.upload_url, tarball, md5);
        yield* completeBuild(auth, cluster, build.build_id);
        return build.build_id;
      }, Effect.scoped);

      /** Wait until Rivet has verified and prepared a build. */
      const waitForBuild = (auth: CloudAuth, cluster: string, buildId: string) =>
        getBuild(auth, cluster, buildId).pipe(
          Effect.flatMap((info): Effect.Effect<void, Pending | RunnerBuildFailed> => {
            if (info.status === "ready") return Effect.void;
            if (["failed", "expired", "deleting"].includes(info.status)) {
              return Effect.fail(
                new RunnerBuildFailed({
                  message: `Rivet Cloud build ${info.build_id} is ${info.status}${
                    info.failure
                      ? ` (${info.failure.fault} fault, ${info.failure.code}): ${info.failure.message}`
                      : ""
                  }`,
                }),
              );
            }
            return Effect.fail(
              new Pending({ message: `build ${info.build_id} is ${info.status}` }),
            );
          }),
          // Rivet gives up preparing a build after 30 minutes.
          Effect.retry({
            while: (e) => e._tag === "RivetCloud.Pending",
            schedule: Schedule.spaced("5 seconds"),
            times: 420,
          }),
        );

      const rolledOut = (
        pool: RunnerPoolInfo,
        buildId: string,
      ): Effect.Effect<void, Pending | RunnerPoolRolloutFailed> => {
        if (pool.build_id !== buildId) {
          return Effect.fail(
            new RunnerPoolRolloutFailed({
              message: `Runner pool ${pool.pool} was moved to another build while rolling out`,
            }),
          );
        }
        const { state, replicas, action_needed, fault, message } = pool.status;
        if (
          state === "ready" &&
          replicas !== null &&
          replicas.updated >= replicas.desired &&
          replicas.ready >= replicas.desired
        ) {
          return Effect.void;
        }
        // A fault in the image needs a new one; Rivet keeps retrying the old.
        if (action_needed && (fault === "user" || state === "degraded" || state === "down")) {
          return Effect.fail(
            new RunnerPoolRolloutFailed({
              message: `Runner pool ${pool.pool} failed: ${message ?? "the deployed build failed"}`,
            }),
          );
        }
        return Effect.fail(new Pending({ message: `runner pool ${pool.pool} is ${state}` }));
      };

      const observe = Effect.fn(function* (cluster: string, region: string, name: string) {
        const auth = yield* credentials;
        return yield* getRunnerPool(auth, cluster, region, name).pipe(
          Effect.catchTag("RivetCloud.NotFound", () => Effect.undefined),
        );
      });

      const regionOf = Effect.fn(function* (props: RunnerPoolProps, current?: string) {
        if (props.region !== undefined) return props.region;
        if (current !== undefined) return current;
        const auth = yield* credentials;
        const [first] = yield* listRegions(auth, props.cluster);
        if (first === undefined) {
          return yield* new NoClusterRegion({
            message: `Rivet Cloud cluster '${props.cluster}' has no region to run a runner pool in.`,
          });
        }
        return first.region;
      });

      return {
        stables: ["name", "cluster", "region"],
        diff: Effect.fn(function* ({ news, olds, output }) {
          if (!isResolved(news)) return undefined;
          if (nameOf(news) !== (output?.name ?? (olds ? nameOf(olds) : undefined))) {
            return { action: "replace" } as const;
          }
          if (news.cluster !== (output?.cluster ?? olds?.cluster)) {
            return { action: "replace" } as const;
          }
          if (news.region !== undefined && news.region !== output?.region) {
            return { action: "replace" } as const;
          }
          // The program is a file: a new bundle at the same path is a change.
          const { digest } = yield* imageFiles(news);
          if (digest !== output?.digest) return { action: "update" } as const;
        }),
        read: Effect.fn(function* ({ olds, output }) {
          if (output !== undefined) {
            const pool = yield* observe(output.cluster, output.region, output.name);
            if (pool === undefined || pool.build_id === null) return undefined;
            return { ...output, buildId: pool.build_id };
          }
          // A runner pool carries no tags, and a cluster has one: one found
          // with no state of ours belongs to another stack or stage.
          const region = yield* regionOf(olds);
          const pool = yield* observe(olds.cluster, region, nameOf(olds));
          if (pool === undefined || pool.build_id === null) return undefined;
          return Unowned({
            name: pool.pool,
            cluster: olds.cluster,
            region: pool.region,
            buildId: pool.build_id,
            digest: "",
          });
        }),
        reconcile: Effect.fn(function* ({ news, output, session }) {
          const note = (message: string) => session.note(message);
          const region = yield* regionOf(news, output?.region);
          // Observe
          const name = nameOf(news);
          const pool = yield* observe(news.cluster, region, name);
          // Ensure the build: reuse the one the pool runs when the image is unchanged.
          const { files, digest } = yield* imageFiles(news);
          const unchanged =
            pool !== undefined &&
            pool.build_id !== null &&
            output?.digest === digest &&
            pool.build_id === output.buildId;
          const buildId = unchanged
            ? pool.build_id!
            : yield* uploadImage(news, files, digest, note);
          // Sync the pool to the build, machine type and node count.
          const auth = yield* credentials;
          if (
            pool === undefined ||
            pool.build_id !== buildId ||
            pool.machine_type !== machineTypeOf(news) ||
            pool.node_count !== nodeCountOf(news)
          ) {
            yield* note(`Rolling out runner pool ${name} to build ${buildId}...`);
            yield* putRunnerPool(auth, news.cluster, region, name, {
              build_id: buildId,
              // The upsert replaces the allowlist, so an existing pool's is sent back.
              cidr_allowlist: pool?.cidr_allowlist ?? [],
              machine_type: machineTypeOf(news),
              node_count: nodeCountOf(news),
            });
          }
          yield* getRunnerPool(auth, news.cluster, region, name).pipe(
            Effect.flatMap((current) => rolledOut(current, buildId)),
            Effect.retry({
              while: (e) => e._tag === "RivetCloud.Pending" || e._tag === "RivetCloud.NotFound",
              schedule: Schedule.spaced("2 seconds"),
              times: 450,
            }),
          );
          // The build the pool ran before is no longer needed.
          const previous = pool?.build_id;
          if (previous && previous !== buildId) {
            yield* deleteBuild(auth, news.cluster, previous).pipe(Effect.ignore);
          }
          return { name, cluster: news.cluster, region, buildId, digest };
        }),
        delete: Effect.fn(function* ({ output }) {
          const auth = yield* credentials;
          yield* deleteRunnerPool(auth, output.cluster, output.region, output.name).pipe(
            Effect.catchTag("RivetCloud.NotFound", () => Effect.void),
          );
          // A build is refused deletion while its pool still runs it.
          yield* observe(output.cluster, output.region, output.name).pipe(
            Effect.flatMap((pool): Effect.Effect<void, Pending> =>
              pool === undefined
                ? Effect.void
                : Effect.fail(new Pending({ message: `runner pool ${output.name} is deleting` })),
            ),
            Effect.retry({
              while: (e) => e._tag === "RivetCloud.Pending",
              schedule: Schedule.spaced("5 seconds"),
              times: 120,
            }),
          );
          // Rivet keeps a pool's recent builds for rollbacks, and refuses to
          // delete one until a couple of minutes after its pool is gone.
          const repository = `${imageRepository(output.cluster, output.name)}:`;
          const builds = (yield* listBuilds(auth, output.cluster)).filter(
            (build) => build.image.startsWith(repository) && build.status !== "deleting",
          );
          yield* Effect.forEach(
            builds,
            (build) =>
              deleteBuild(auth, output.cluster, build.build_id).pipe(
                Effect.retry({
                  while: (e) => e._tag === "RivetCloud.Conflict",
                  schedule: Schedule.spaced("10 seconds"),
                  times: 36,
                }),
                Effect.catchTag("RivetCloud.NotFound", () => Effect.void),
              ),
            { concurrency: "unbounded" },
          );
        }),
      };
    }),
  );
