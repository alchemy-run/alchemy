import { createHash } from "node:crypto";
import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import type { InlineDockerfile } from "@alchemy.run/docker/Dockerfile";
import * as DockerfileParser from "@alchemy.run/docker/DockerfileParser";
import {
  computeStaticSourceHash,
  makeContainerImageSource,
  type DockerfileImageSource,
  type ImageRegistryTarget,
} from "@alchemy.run/docker/ImageSource";
import * as dockerRegistry from "@distilled.cloud/daytona/docker_registry";
import * as sandboxes from "@distilled.cloud/daytona/sandbox";
import * as snapshots from "@distilled.cloud/daytona/snapshots";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { uploadBuildContext } from "./internal/BuildContext.ts";
import { declarable } from "./internal/Declared.ts";
import { createInternalLabels } from "./internal/Labels.ts";
import { isOwnedName, resolveName } from "./internal/Names.ts";
import { runCommand } from "./internal/Process.ts";
import { resolved, type Ref } from "./internal/Ref.ts";
import { waitForState, waitUntilGone } from "./internal/Wait.ts";
import type { Providers } from "./Providers.ts";

/** A snapshot, by name. Accepts a `Daytona.Snapshot` or `{ name }`. */
export type SnapshotRef = { readonly name: string };

/** A private registry. Accepts a `Daytona.Registry` or `{ registryId }`. */
export type SnapshotRegistry = { readonly registryId: string };

export type GpuType = snapshots.GpuType;

export interface SnapshotBuild {
  /** Build arguments, read by the Dockerfile's `ARG` instructions. */
  args?: Record<string, string>;
  /**
   * BuildKit secrets, keyed by id; mount one in a `RUN` step with
   * `--mount=type=secret,id=<id>`. They never enter the image or its hash.
   * Daytona's builders can't receive secrets, so setting any builds locally.
   */
  secrets?: Record<string, Redacted.Redacted<string>>;
  /**
   * Build on Daytona's builders (`true`), or with your local Docker
   * (`false`), pushing the image to Daytona's registry. Build locally to use
   * build secrets, base images only your machine can pull, or your local
   * layer cache.
   * @default true, unless `secrets` are set
   */
  remote?: boolean;
}

export interface SnapshotProps {
  /**
   * Snapshot name, unique in the organization. Sandboxes are created from
   * it by name. If omitted, a unique name is generated from the stack,
   * stage and logical ID. Changing it replaces the snapshot.
   */
  name?: string;
  /**
   * An image to pull, with an explicit tag or digest (Daytona rejects
   * `latest`, `lts` and `stable`). Pass a {@link Registry} as `registry`
   * for private images. Exclusive with `dockerfile` and `from`.
   */
  image?: string;
  /**
   * A Dockerfile to build: a path (relative to the cwd), or inline content
   * (`Dockerfile.inline`). Daytona builds it on its own builders, uploading
   * the files it `COPY`s from {@link context}; no local Docker is needed.
   * Set `build.remote: false` to build it with your local Docker instead.
   * Changing the Dockerfile or any file it copies replaces the snapshot.
   * Exclusive with `image` and `from`.
   * @default `${context}/Dockerfile` when `context` is set
   */
  dockerfile?: string | InlineDockerfile;
  /**
   * Build context directory for a Dockerfile path. Only the files its
   * `COPY`/`ADD` instructions reach are uploaded (after `.dockerignore`).
   * Inline Dockerfiles have no context and can't `COPY` local files.
   */
  context?: string;
  /** How the Dockerfile is built. */
  build?: SnapshotBuild;
  /**
   * Build a warm base from another snapshot: start a sandbox from `from`,
   * run `run` in it, and capture its filesystem as this snapshot. Use it to
   * bake a cloned repository and installed dependencies into the snapshot
   * sandboxes fork from. Exclusive with `image` and `dockerfile`.
   */
  from?: Ref<SnapshotRef>;
  /**
   * Shell commands run in order in the `from` sandbox before it is
   * captured. A non-zero exit fails the deploy.
   */
  run?: string[];
  /** Private registry to pull `image` (or a Dockerfile's base) from. */
  registry?: Ref<SnapshotRegistry>;
  /** The command a sandbox from this snapshot runs. */
  entrypoint?: string[];
  /** vCPUs for sandboxes from this snapshot. */
  cpu?: number;
  /** Memory in GiB. */
  memory?: number;
  /** Disk in GiB. */
  disk?: number;
  /** GPUs per sandbox. Billed per hour while a sandbox runs. */
  gpu?: number;
  /** Acceptable GPU types, in order of preference. */
  gpuType?: GpuType[];
  /** Region to build the snapshot in. */
  regionId?: string;
  /** Sandbox class (`container`, `linux-vm`, …). Dockerfile builds need `container`. */
  sandboxClass?: snapshots.SandboxClass;
}

export interface SnapshotAttributes {
  /** Snapshot ID. */
  snapshotId: string;
  /** Snapshot name; what sandboxes are created from. */
  name: string;
  /** State (`active` once usable). */
  state: snapshots.SnapshotState;
  /** The pulled or built image. */
  imageName: string | undefined;
  /** Internal image reference. */
  ref: string | undefined;
  /** vCPUs. */
  cpu: number;
  /** Memory in GiB. */
  memory: number;
  /** Disk in GiB. */
  disk: number;
  /** GPUs. */
  gpu: number;
  /** The sandbox this snapshot was captured from, for `from` snapshots. */
  sourceSandboxId: string | undefined;
  /** Hash of everything the snapshot was built from. */
  buildHash: string;
}

export type Snapshot = Resource<
  "Daytona.Snapshot",
  SnapshotProps,
  SnapshotAttributes,
  never,
  Providers,
  SnapshotLookup
>;

/**
 * Props for {@link Snapshot.lookup}: find a snapshot this stack
 * doesn't manage by its name or id.
 */
export interface SnapshotLookup {
  /** Snapshot name or id. */
  name: string;
}

/**
 * A Daytona snapshot: the image sandboxes boot from, with its default
 * size. Pull one from a registry, build one from a Dockerfile on
 * Daytona's builders, or capture one from a sandbox after running setup
 * commands in it (a warm base to fork from).
 *
 * Snapshots are immutable: changing what one is built from replaces it.
 * Daytona deactivates a snapshot after two weeks without use; deploy
 * reactivates it.
 * @see https://www.daytona.io/docs/en/snapshots/
 *
 * ### Pulling an Image
 * **Example:** A public image with a size
 * ```typescript
 * export const Node = Daytona.Snapshot("Node", {
 *   image: "node:22-bookworm",
 *   cpu: 2,
 *   memory: 4,
 *   disk: 10,
 * });
 * ```
 *
 * ### Building from a Dockerfile
 * **Example:** An inline Dockerfile built by Daytona
 * ```typescript
 * export const Base = Daytona.Snapshot("Base", {
 *   dockerfile: Dockerfile.inline`
 *     FROM node:22-bookworm
 *     RUN apt-get update && apt-get install -y git ripgrep
 *   `,
 *   cpu: 2,
 *   memory: 4,
 * });
 * ```
 *
 * ### Building a Directory
 * **Example:** A Dockerfile and the files it copies
 * ```typescript
 * export const App = Daytona.Snapshot("App", {
 *   context: "./sandbox",
 *   build: { args: { NODE_ENV: "production" } },
 * });
 * ```
 *
 * ### Building with Local Docker
 * **Example:** A build that reads a private npm token
 * ```typescript
 * export const App = Daytona.Snapshot("App", {
 *   context: "./sandbox",
 *   build: {
 *     remote: false,
 *     secrets: { npmrc: Redacted.make(process.env.NPM_TOKEN!) },
 *   },
 * });
 * ```
 *
 * ### A Warm Base to Fork From
 * **Example:** Clone and install once, then start every sandbox from it
 * ```typescript
 * export const Warm = Daytona.Snapshot("Warm", {
 *   from: Base,
 *   run: [
 *     "git clone https://github.com/alchemy-run/alchemy /home/daytona/alchemy",
 *     "cd /home/daytona/alchemy && pnpm install",
 *   ],
 * });
 * ```
 *
 * ### Looking up an existing snapshot
 * `Snapshot.lookup` references a snapshot Alchemy doesn't manage (created in
 * the Daytona dashboard or by another stack). It is read during plan/deploy,
 * never created, updated or deleted.
 * `buildHash` is empty: the image wasn't built by this stack.
 *
 * **Example:** Start a sandbox from an existing snapshot
 * ```typescript
 * const base = Daytona.Snapshot.lookup({ name: "python-ml" });
 * ```
 *
 * @resource
 * @product Snapshot
 */
export const Snapshot = declarable<Snapshot>()(Resource<Snapshot>("Daytona.Snapshot"));

/**
 * What Daytona's builders can build: any Dockerfile, for amd64. Daytona's
 * build request has no field for build arguments, so the plan bakes them
 * into `ARG` defaults, nor for BuildKit secrets, so the plan rejects them.
 */
export const capabilities: BuildPlan.Capabilities = {
  target: "Daytona.Snapshot",
  buildArgs: false,
  secrets: false,
  platforms: ["linux/amd64"],
};

/** The snapshot props name more than one of `image`, `dockerfile` and `from`, or none. */
export class SnapshotSourceInvalid extends Data.TaggedError("Daytona.SnapshotSourceInvalid")<{
  readonly message: string;
}> {}

/** A runtime build's Dockerfile copies local files, which only a deploy-time `context` can provide. */
export class SnapshotContextUnsupported extends Data.TaggedError(
  "Daytona.SnapshotContextUnsupported",
)<{
  readonly line: string;
}> {
  override get message() {
    return `A snapshot built at runtime can't copy local files (${this.line.trim()}). Declare it with Daytona.Snapshot and a \`context\`, or fetch the files in a RUN step.`;
  }
}

/** A `run` command exited non-zero while building a snapshot from a sandbox. */
export class SnapshotRunFailed extends Data.TaggedError("Daytona.SnapshotRunFailed")<{
  readonly command: string;
  readonly exitCode: number;
  readonly output: string;
}> {
  override get message() {
    return `\`${this.command}\` exited ${this.exitCode} while building the snapshot:\n${this.output.slice(-2000)}`;
  }
}

/** The image has no tag, or a moving one Daytona rejects. */
export class SnapshotImageTagInvalid extends Data.TaggedError("Daytona.SnapshotImageTagInvalid")<{
  readonly image: string;
}> {
  override get message() {
    return `Daytona needs an image with a fixed tag or digest; got ${this.image} (latest, lts and stable are rejected)`;
  }
}

const sha256 = (value: unknown) =>
  Effect.sync(() => createHash("sha256").update(JSON.stringify(value)).digest("hex"));

const refName = <T extends { readonly name: string }>(ref: Ref<T> | undefined) =>
  Effect.succeed(ref === undefined ? undefined : resolved(ref).name);

const checkImage = (image: string) => {
  const last = image.split("/").at(-1) ?? image;
  const tag = image.includes("@")
    ? "digest"
    : last.includes(":")
      ? last.split(":").at(-1)!
      : undefined;
  return tag === undefined || ["latest", "lts", "stable"].includes(tag)
    ? Effect.fail(new SnapshotImageTagInvalid({ image }))
    : Effect.void;
};

/** The Dockerfile's text for Daytona; the plan has baked build arguments in. */
const dockerfileText = (plan: BuildPlan.BuildPlan) => DockerfileParser.render(plan.dockerfile);

/**
 * Check Dockerfile content built at runtime (a Worker has no file system,
 * so there is no context to copy from).
 */
export const checkRuntimeDockerfile = Effect.fn(function* (content: string) {
  const parsed = yield* DockerfileParser.parse(content);
  const { violations } = BuildPlan.check(parsed, capabilities, "linux/amd64");
  if (violations.length > 0) {
    return yield* new BuildPlan.UnsupportedDockerfile({
      target: capabilities.target,
      violations,
      message: violations.map((v) => `line ${v.line}: ${v.instruction}: ${v.reason}`).join("\n"),
    });
  }
  for (const stage of parsed.stages) {
    for (const instruction of stage.instructions) {
      if (instruction._tag !== "COPY" && instruction._tag !== "ADD") continue;
      if (instruction.flags.some((flag) => flag.name === "from")) continue;
      const local = instruction.sources.filter(
        (source) => !/^(https?:\/\/|git@)/.test(source) && !source.startsWith("<<"),
      );
      if (local.length > 0) return yield* new SnapshotContextUnsupported({ line: instruction.raw });
    }
  }
});

/** What the snapshot is built from, resolved; its hash decides rebuilds. */
const resolveSource = Effect.fn(function* (news: SnapshotProps) {
  const fromDockerfile = news.dockerfile !== undefined || news.context !== undefined;
  const sources = [news.image, fromDockerfile ? true : undefined, news.from].filter(
    (s) => s !== undefined,
  );
  if (sources.length !== 1) {
    return yield* new SnapshotSourceInvalid({
      message: "Daytona.Snapshot takes exactly one of `image`, `dockerfile`/`context` or `from`",
    });
  }
  if (news.image !== undefined) yield* checkImage(news.image);
  // A Dockerfile builds on Daytona unless it asks for local Docker, or
  // has build secrets (Daytona's builders can't receive them).
  const remote = news.build?.remote ?? news.build?.secrets === undefined;
  const local: DockerfileImageSource | undefined =
    fromDockerfile && !remote
      ? {
          dockerfile: news.dockerfile,
          context: news.context,
          build: { args: news.build?.args, secrets: news.build?.secrets },
        }
      : undefined;
  const plan =
    fromDockerfile && remote
      ? yield* BuildPlan.plan(
          { dockerfile: news.dockerfile, context: news.context, build: { args: news.build?.args } },
          { capabilities },
        )
      : undefined;
  const sizing = {
    entrypoint: news.entrypoint,
    cpu: news.cpu,
    memory: news.memory,
    disk: news.disk,
    gpu: news.gpu,
    gpuType: news.gpuType,
    regionId: news.regionId,
    sandboxClass: news.sandboxClass,
  };
  const source = {
    image: news.image,
    dockerfile: plan ? dockerfileText(plan) : undefined,
    from: yield* refName(news.from),
    run: news.run ?? [],
    ...sizing,
  };
  const buildHash = yield* sha256({
    image: source.image,
    plan: plan?.hash,
    local: local ? yield* computeStaticSourceHash(local, "linux/amd64") : undefined,
    from: source.from,
    run: source.run,
    ...sizing,
  });
  return { source, plan, local, buildHash };
});

export const toSnapshotAttributes = (
  s: snapshots.SnapshotDto,
  buildHash: string,
): SnapshotAttributes => ({
  snapshotId: s.id,
  name: s.name,
  state: s.state,
  imageName: s.imageName,
  ref: s.ref,
  cpu: s.cpu,
  memory: s.mem,
  disk: s.disk,
  gpu: s.gpu,
  sourceSandboxId: s.sourceSandboxId ?? undefined,
  buildHash,
});

export const getSnapshot = (idOrName: string) =>
  snapshots
    .getSnapshot({ id: idOrName })
    .pipe(Effect.catchTag("SnapshotNotFound", () => Effect.undefined));

/** Wait for a snapshot to become usable, reactivating it when Daytona has deactivated it. */
export const waitForSnapshot = Effect.fn(function* (idOrName: string) {
  const current = yield* snapshots.getSnapshot({ id: idOrName });
  if (current.state === "inactive") yield* snapshots.activateSnapshot({ id: current.id });
  return yield* waitForState({
    kind: "snapshot",
    id: idOrName,
    observe: snapshots.getSnapshot({ id: idOrName }),
    want: ["active"],
    fail: ["error", "build_failed"],
    reason: (s) => s.errorReason,
    budget: "30 minutes",
  });
});

/** Delete a snapshot by name (Daytona deletes by id). Deleting a missing one succeeds. */
export const deleteSnapshotByName = Effect.fn(function* (name: string) {
  const found = yield* getSnapshot(name);
  if (found !== undefined) yield* deleteSnapshot(found.id);
});

export const deleteSnapshot = Effect.fn(function* (idOrName: string) {
  yield* snapshots
    .removeSnapshot({ id: idOrName })
    .pipe(Effect.catchTag("SnapshotNotFound", () => Effect.void));
  yield* waitUntilGone(
    "snapshot",
    idOrName,
    getSnapshot(idOrName).pipe(Effect.map((s) => s !== undefined)),
    "5 minutes",
  );
});

/**
 * Start a sandbox from `from`, run the commands in it and capture it as a
 * snapshot named `name`. The build sandbox is deleted whatever happens, and
 * deletes itself after an hour if this process dies first.
 */
export const captureSnapshot = Effect.fn(function* (input: {
  readonly labels: Record<string, string>;
  readonly name: string;
  readonly from: string;
  readonly run: readonly string[];
  readonly note: (message: string) => Effect.Effect<void>;
}) {
  const build = yield* Effect.acquireRelease(
    sandboxes.createSandbox({
      name: `${input.name}-build`.slice(0, 63),
      snapshot: input.from,
      labels: { ...input.labels, "alchemy.role": "snapshot-build" },
      autoDeleteInterval: 60,
    }),
    (sandbox) =>
      sandboxes.deleteSandbox({ sandboxIdOrName: sandbox.id }).pipe(
        Effect.catchTag("SandboxNotFound", () => Effect.void),
        Effect.ignore,
      ),
  );
  const started = yield* waitForState({
    kind: "sandbox",
    id: build.id,
    observe: sandboxes.getSandbox({ sandboxIdOrName: build.id }),
    want: ["started"],
    fail: ["error", "build_failed", "destroyed"],
    reason: (s) => s.errorReason,
  });
  for (const command of input.run) {
    yield* input.note(`Running \`${command}\` in the snapshot build sandbox...`);
    const result = yield* runCommand(started.id, started.toolboxProxyUrl, {
      command,
      timeout: 1800,
    });
    if ((result.exitCode ?? 0) !== 0) {
      return yield* new SnapshotRunFailed({
        command,
        exitCode: result.exitCode ?? -1,
        output: result.result,
      });
    }
  }
  yield* input.note(`Capturing snapshot ${input.name}...`);
  yield* sandboxes.createSandboxSnapshot({ sandboxIdOrName: started.id, name: input.name });
  return yield* waitForSnapshot(input.name);
}, Effect.scoped);

/** A snapshot's source with every input resolved (Dockerfile as content). */
export interface ResolvedSnapshotSource {
  readonly image?: string | undefined;
  readonly dockerfile?: string | undefined;
  readonly from?: string | undefined;
  readonly run?: readonly string[] | undefined;
  readonly entrypoint?: string[] | undefined;
  readonly cpu?: number | undefined;
  readonly memory?: number | undefined;
  readonly disk?: number | undefined;
  readonly gpu?: number | undefined;
  readonly gpuType?: GpuType[] | undefined;
  readonly regionId?: string | undefined;
  readonly sandboxClass?: snapshots.SandboxClass | undefined;
  /** Uploaded build contexts the Dockerfile copies from (`buildInfo.contextHashes`). */
  readonly contextHashes?: string[] | undefined;
}

/**
 * Build a snapshot named `name` and wait until it is active: pull or
 * build on Daytona's builders, or capture it from a `from` sandbox after
 * running `run`. Shared by the resource and the runtime binding.
 */
export const buildSnapshot = Effect.fn(function* (input: {
  readonly name: string;
  readonly source: ResolvedSnapshotSource;
  readonly labels: Record<string, string>;
  readonly note: (message: string) => Effect.Effect<void>;
}) {
  const { name, source } = input;
  if (source.from !== undefined) {
    return yield* captureSnapshot({
      labels: input.labels,
      name,
      from: source.from,
      run: source.run ?? [],
      note: input.note,
    });
  }
  if (source.image !== undefined) yield* checkImage(source.image);
  yield* input.note(
    source.dockerfile !== undefined
      ? `Building snapshot ${name} on Daytona...`
      : `Pulling ${source.image} into snapshot ${name}...`,
  );
  yield* snapshots
    .createSnapshot({
      name,
      imageName: source.image,
      buildInfo:
        source.dockerfile !== undefined
          ? { dockerfileContent: source.dockerfile, contextHashes: source.contextHashes }
          : undefined,
      entrypoint: source.entrypoint,
      cpu: source.cpu,
      memory: source.memory,
      disk: source.disk,
      gpu: source.gpu,
      gpuType: source.gpuType,
      regionId: source.regionId,
      sandboxClass: source.sandboxClass,
    })
    .pipe(Effect.catchTag("SnapshotAlreadyExists", () => Effect.void));
  return yield* waitForSnapshot(name);
});

/**
 * Daytona's transient registry as a push target: a short-lived robot
 * account scoped to the organization's own project, which Daytona pulls
 * snapshots from without a registry entry.
 */
const transientRegistry = Effect.fn(function* (name: string, regionId: string | undefined) {
  const access = yield* dockerRegistry.getTransientPushAccess({ regionId });
  return {
    repositoryUri: Effect.succeed(`${access.registryUrl}/${access.project}/${name}`),
    // Pushes are content-addressed and the registry can't be listed with
    // this account; pushing an existing tag is a no-op upload.
    hasTag: () => Effect.succeed(false),
    credentials: Effect.succeed({
      server: access.registryUrl,
      username: access.username,
      password: access.secret,
    }),
  } satisfies ImageRegistryTarget;
});

export const SnapshotProvider = () =>
  Provider.effect(
    Snapshot,
    Effect.gen(function* () {
      const images = yield* makeContainerImageSource;
      return {
        stables: ["snapshotId"],
        list: Effect.fn(function* () {
          const all = yield* snapshots.getAllSnapshots.items({}).pipe(Stream.runCollect);
          return Array.from(all)
            .filter((s) => !s.general)
            .map((s) => toSnapshotAttributes(s, ""));
        }),
        diff: Effect.fn(function* ({ id, news, output }) {
          if (!isResolved(news) || output === undefined) return undefined;
          const name = yield* resolveName(
            id,
            news.name,
            news.name === undefined ? output.name : undefined,
          );
          const { buildHash } = yield* resolveSource(news);
          if (name !== output.name || buildHash !== output.buildHash) {
            // Sandboxes reference snapshots by name, so a pinned name is freed first.
            return { action: "replace", deleteFirst: name === output.name } as const;
          }
        }),
        lookup: Effect.fn(function* ({ name }) {
          const found = yield* getSnapshot(name);
          return found === undefined ? undefined : toSnapshotAttributes(found, "");
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const name = yield* resolveName(id, olds?.name, output?.name);
          const found =
            (output ? yield* getSnapshot(output.snapshotId) : undefined) ??
            (yield* getSnapshot(name));
          if (found === undefined) return undefined;
          const attrs = toSnapshotAttributes(found, output?.buildHash ?? "");
          return (yield* isOwnedName(id, found.name, output !== undefined))
            ? attrs
            : Unowned(attrs);
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* resolveName(id, news.name, output?.name);
          const { source, plan, local, buildHash } = yield* resolveSource(news);

          // Observe
          const current = yield* getSnapshot(output?.snapshotId ?? name);
          if (current !== undefined && current.name === name) {
            // Ensure usable: reactivate a snapshot Daytona deactivated after
            // two weeks unused, and wait out a build already in flight.
            const ready = current.state === "active" ? current : yield* waitForSnapshot(current.id);
            return toSnapshotAttributes(ready, output?.buildHash ?? buildHash);
          }

          // Ensure — a local build pushes its image to Daytona's registry,
          // which the snapshot then pulls.
          if (local !== undefined) {
            yield* session.note(`Building ${name} with local Docker...`);
            const pushed = yield* images.resolve(
              { id, source: local, session, platform: "linux/amd64", bootstrap: () => "" },
              yield* transientRegistry(name, news.regionId),
            );
            const built = yield* buildSnapshot({
              name,
              source: { ...source, dockerfile: undefined, image: pushed.imageUri },
              labels: yield* createInternalLabels(id),
              note: session.note,
            });
            return toSnapshotAttributes(built, buildHash);
          }

          // Ensure — upload what the Dockerfile copies, then build.
          for (const warning of plan?.warnings ?? []) yield* session.note(warning);
          const contextHashes =
            plan !== undefined && plan.files.length > 0
              ? [yield* uploadBuildContext(plan)]
              : undefined;
          const built = yield* buildSnapshot({
            name,
            source: { ...source, contextHashes },
            labels: yield* createInternalLabels(id),
            note: session.note,
          });
          return toSnapshotAttributes(built, buildHash);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteSnapshot(output.snapshotId);
        }),
      };
    }),
  );
