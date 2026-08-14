/**
 * Build Output v3 artifact constructors (DESIGN §6.1 / §7.2).
 *
 * Every compute shape is a different way of producing a `.vercel/output`
 * tree; these constructors turn each producer's output into a
 * {@link DeploymentArtifact} for the shared engine.
 *
 * NOT exported from `Vercel/index.ts`.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type { PlatformError } from "effect/PlatformError";
import {
  artifactFileFromBytes,
  artifactFileFromDisk,
  makeArtifact,
  type ArtifactFile,
  type DeploymentArtifact,
} from "./Artifact.ts";

const OUTPUT_PREFIX = ".vercel/output";

/** A route entry in Build Output v3 `config.json`. */
export interface BuildOutputRoute {
  readonly [key: string]: unknown;
}

export interface CronEntry {
  readonly path: string;
  readonly schedule: string;
}

/**
 * A queue trigger contributed through the Function binding channel by the
 * `subscribe` event source (DESIGN D9a).
 */
export interface QueueTriggerEntry {
  /** Topic name the trigger consumes. */
  readonly topic: string;
  /** Consumer group the platform consumes under (REQUIRED — live-verified). */
  readonly consumer: string;
  /** Redelivery backoff after a failed delivery, in seconds. */
  readonly retryAfterSeconds?: number;
  /** Delay before the first delivery attempt, in seconds. */
  readonly initialDelaySeconds?: number;
}

/** The `experimentalTriggers` entry shape in `.vc-config.json`. */
export interface QueueTriggerConfig extends QueueTriggerEntry {
  readonly type: "queue/v2beta";
}

/** `.vc-config.json` for a Node serverless (Fluid) function. */
export interface VcConfig {
  readonly runtime: string;
  readonly handler: string;
  readonly launcherType: "Nodejs";
  readonly supportsResponseStreaming?: boolean;
  readonly maxDuration?: number;
  readonly regions?: ReadonlyArray<string>;
  readonly environment?: Record<string, string>;
  /**
   * Queue triggers (`queue/v2beta`). Only ever set on the SEPARATE consumer
   * function — a trigger on the public function kills ALL public HTTP
   * routing (live-verified, D9a).
   */
  readonly experimentalTriggers?: ReadonlyArray<QueueTriggerConfig>;
}

/**
 * The dedicated queue-consumer function name (D9a): the platform invokes it
 * directly for queue deliveries; it is never routed in `config.json`, so it
 * stays publicly unreachable while the `index` function keeps serving HTTP.
 */
export const QUEUE_CONSUMER_FUNCTION = "_alchemy-queue";

const encoder = new TextEncoder();

const jsonBytes = (value: unknown): Uint8Array =>
  encoder.encode(JSON.stringify(value));

/**
 * Recursively list every file under `root` as sorted POSIX-relative paths.
 */
const walkFiles = (
  root: string,
): Effect.Effect<string[], PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const out: string[] = [];
    const go: (rel: string) => Effect.Effect<void, PlatformError> = Effect.fn(
      function* (rel: string) {
        const absolute = rel === "" ? root : `${root}/${rel}`;
        const entries = yield* fs.readDirectory(absolute);
        for (const entry of entries) {
          const childRel = rel === "" ? entry : `${rel}/${entry}`;
          const info = yield* fs.stat(`${root}/${childRel}`);
          if (info.type === "Directory") {
            yield* go(childRel);
          } else {
            out.push(childRel);
          }
        }
      },
    );
    yield* go("");
    return out.sort();
  });

/**
 * Build the artifact for a hand-written Function: a single `index` function
 * plus optional static assets (DESIGN §7.2 catch-all shape).
 *
 * Contributed `routes` (binding channel) are merged BEFORE the filesystem
 * handler; the catch-all `/index` rewrite comes last.
 */
export const fromFunctionBundle = (input: {
  /** Bundled module files, paths relative to `index.func/` (entry `index.mjs`). */
  readonly bundle: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
  readonly vcConfig: VcConfig;
  readonly crons?: ReadonlyArray<CronEntry>;
  readonly routes?: ReadonlyArray<BuildOutputRoute>;
  /** Optional directory of static assets shipped under `static/`. */
  readonly staticDir?: string;
  /**
   * Optional queue-consumer function (D9a): a SEPARATE
   * `functions/_alchemy-queue.func` carrying the `experimentalTriggers` in
   * ITS `.vc-config.json`, so the public `index` function keeps its HTTP
   * routing. Deliberately absent from `config.json` routes — the platform
   * invokes it directly for queue deliveries.
   */
  readonly queueConsumer?: {
    /** Bundled module files, paths relative to `_alchemy-queue.func/`. */
    readonly bundle: ReadonlyArray<{ path: string; bytes: Uint8Array }>;
    readonly vcConfig: VcConfig;
  };
}): Effect.Effect<DeploymentArtifact, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const files: ArtifactFile[] = [];

    const config = {
      version: 3,
      routes: [
        ...(input.routes ?? []),
        { handle: "filesystem" },
        { src: "/.*", dest: "/index" },
      ],
      ...(input.crons !== undefined && input.crons.length > 0
        ? { crons: input.crons }
        : {}),
    };
    files.push(
      yield* artifactFileFromBytes(
        `${OUTPUT_PREFIX}/config.json`,
        jsonBytes(config),
      ),
    );
    files.push(
      yield* artifactFileFromBytes(
        `${OUTPUT_PREFIX}/functions/index.func/.vc-config.json`,
        jsonBytes(input.vcConfig),
      ),
    );
    for (const file of input.bundle) {
      files.push(
        yield* artifactFileFromBytes(
          `${OUTPUT_PREFIX}/functions/index.func/${file.path}`,
          file.bytes,
        ),
      );
    }
    if (input.queueConsumer !== undefined) {
      files.push(
        yield* artifactFileFromBytes(
          `${OUTPUT_PREFIX}/functions/${QUEUE_CONSUMER_FUNCTION}.func/.vc-config.json`,
          jsonBytes(input.queueConsumer.vcConfig),
        ),
      );
      for (const file of input.queueConsumer.bundle) {
        files.push(
          yield* artifactFileFromBytes(
            `${OUTPUT_PREFIX}/functions/${QUEUE_CONSUMER_FUNCTION}.func/${file.path}`,
            file.bytes,
          ),
        );
      }
    }
    if (input.staticDir !== undefined) {
      const rels = yield* walkFiles(input.staticDir);
      for (const rel of rels) {
        files.push(
          yield* artifactFileFromDisk(
            `${OUTPUT_PREFIX}/static/${rel}`,
            `${input.staticDir}/${rel}`,
          ),
        );
      }
    }
    return yield* makeArtifact("prebuilt", files);
  });

/**
 * Pass an adapter-produced `.vercel/output` directory through as-is
 * (the `prebuilt:` escape hatch and, later, `Website.*` adapters).
 */
export const fromBuildOutputDir = (
  dir: string,
): Effect.Effect<DeploymentArtifact, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const rels = yield* walkFiles(dir);
    const files: ArtifactFile[] = [];
    for (const rel of rels) {
      files.push(
        yield* artifactFileFromDisk(`${OUTPUT_PREFIX}/${rel}`, `${dir}/${rel}`),
      );
    }
    return yield* makeArtifact("prebuilt", files);
  });

/**
 * Static-only artifact: every file under `dir` ships under `static/` with a
 * plain filesystem-routing `config.json`.
 */
export const fromStaticDir = (
  dir: string,
  routes?: ReadonlyArray<BuildOutputRoute>,
): Effect.Effect<DeploymentArtifact, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const rels = yield* walkFiles(dir);
    const files: ArtifactFile[] = [
      yield* artifactFileFromBytes(
        `${OUTPUT_PREFIX}/config.json`,
        jsonBytes({
          version: 3,
          routes: [...(routes ?? []), { handle: "filesystem" }],
        }),
      ),
    ];
    for (const rel of rels) {
      files.push(
        yield* artifactFileFromDisk(
          `${OUTPUT_PREFIX}/static/${rel}`,
          `${dir}/${rel}`,
        ),
      );
    }
    return yield* makeArtifact("prebuilt", files);
  });

/**
 * Remote-build (source upload) mode is not implemented in v1 — it is the
 * opt-in Next.js fallback (DESIGN §7.3), a later wave.
 */
export class SourceDeployNotSupported extends Data.TaggedError(
  "Vercel.SourceDeployNotSupported",
)<{
  readonly message: string;
}> {}

export const fromSourceDir = (_dir: string): Effect.Effect<never> =>
  Effect.die(
    new SourceDeployNotSupported({
      message:
        "Remote (source-upload) builds are not supported yet — provide a prebuilt .vercel/output tree or a bundleable entry module.",
    }),
  );
