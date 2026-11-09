/**
 * Plans and runs an E2B template build. Shared by the `E2B.Template`
 * resource (which lowers its Dockerfile or `main` through
 * `./TemplatePlan.ts` first) and the runtime `E2B.CreateTemplate` binding.
 *
 * E2B builds remotely only: there is no local Docker step. The flow is
 *
 *   1. `createTemplate` — the template (by name) and a new build id
 *   2. `getTemplateFileUploadLink` per `COPY` hash, uploading what E2B lacks
 *   3. `startTemplateBuild` — base image or template, steps, start/ready command
 *   4. `getTemplateBuildStatus` until the build is `ready` or `error`
 *
 * This module runs where a Worker runs: it imports nothing from
 * `@alchemy.run/docker`.
 */
import * as crypto from "node:crypto";
import * as templates from "@distilled.cloud/e2b/templates";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { E2BUnexpectedResponse, TemplateBuildFailed } from "../Errors.ts";
import { tarGzip } from "./Tar.ts";

/** Credentials for a private base image. Passed to E2B's builder for the pull only. */
export type TemplateRegistry =
  | {
      /** Any registry with username/password auth (Docker Hub, GHCR, …). */
      readonly username: string;
      readonly password: Redacted.Redacted<string>;
    }
  | {
      /** Amazon ECR. */
      readonly awsAccessKeyId: string;
      readonly awsSecretAccessKey: Redacted.Redacted<string>;
      readonly awsRegion: string;
    }
  | {
      /** Google Artifact Registry / GCR. */
      readonly serviceAccountJson: Redacted.Redacted<string>;
    };

/** A file written into the template, from memory. */
export interface TemplateFile {
  /** Absolute path in the template, e.g. `/home/user/app/config.json`. */
  readonly path: string;
  readonly contents: Uint8Array | string;
  /** @default 0o644 */
  readonly mode?: number;
}

/** E2B's own build inputs: a base plus steps, with no Dockerfile. */
export interface TemplateSteps {
  /** A registry image to build on, e.g. `"python:3.12-slim"`. */
  readonly image?: string;
  /** Another E2B template (name or id) to build on, reusing its cached layers. */
  readonly fromTemplate?: string;
  /** Environment variables set in the template (`ENV`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Files written into the template. */
  readonly files?: ReadonlyArray<TemplateFile>;
  /** Shell commands run as extra `RUN` steps, after `env` and `files`. */
  readonly run?: ReadonlyArray<string>;
  /** Credentials for a private base image. */
  readonly registry?: TemplateRegistry;
  /**
   * Command started when the template is built and captured running in its
   * snapshot, so every sandbox starts with it already up.
   */
  readonly startCmd?: string;
  /** Command that exits 0 once `startCmd` is ready; the snapshot is taken then. */
  readonly readyCmd?: string;
}

/** Where a build's template lives and how big its sandboxes are. */
export interface TemplateOptions {
  /** Template name (and alias). */
  readonly name: string;
  /**
   * Tags assigned to this build (e.g. `"v1"`). Sandboxes created from the
   * template id or name boot its `default` tag.
   * @default ["default"]
   */
  readonly tags?: ReadonlyArray<string>;
  readonly cpuCount?: number;
  readonly memoryMB?: number;
  readonly minFreeDiskMb?: number;
  /** Rebuild every layer, ignoring E2B's cache. */
  readonly force?: boolean;
}

export interface TemplateBuildSpec extends TemplateSteps, TemplateOptions {}

/** One file a `COPY` step uploads. */
export interface UploadFile {
  /** Path inside the archive, `/`-separated. */
  readonly path: string;
  readonly mode: number;
  readonly size: number;
  /** Hex SHA-256 of the contents. */
  readonly sha256: string;
  readonly read: Effect.Effect<Uint8Array, PlatformError.PlatformError>;
}

export interface PlannedStep {
  readonly type: "RUN" | "COPY" | "ENV" | "WORKDIR" | "USER";
  readonly args: ReadonlyArray<string>;
  readonly filesHash?: string;
}

/** A base and steps that came before `TemplateSteps`' own: a lowered Dockerfile or program. */
export interface LoweredSource {
  readonly fromImage: string;
  readonly steps: ReadonlyArray<PlannedStep>;
  readonly uploads: ReadonlyMap<string, ReadonlyArray<UploadFile>>;
  /** The start command the source declares (`ENTRYPOINT` / `CMD`). */
  readonly startCmd: string | undefined;
}

export interface TemplateBuildPlan {
  readonly fromImage?: string;
  readonly fromTemplate?: string;
  readonly steps: ReadonlyArray<PlannedStep>;
  readonly startCmd?: string;
  readonly readyCmd?: string;
  /** Files per `COPY` hash, uploaded when E2B does not have them. */
  readonly uploads: ReadonlyMap<string, ReadonlyArray<UploadFile>>;
  /** Content hash of everything that determines the build. A different hash means rebuild. */
  readonly hash: string;
}

export interface TemplateBuildResult {
  readonly templateId: string;
  readonly buildId: string;
  readonly names: ReadonlyArray<string>;
  readonly aliases: ReadonlyArray<string>;
  readonly tags: ReadonlyArray<string>;
  readonly public: boolean;
}

/** E2B's default base image, for a template with no `image`, Dockerfile or `fromTemplate`. */
export const DEFAULT_BASE_IMAGE = "e2bdev/base";

const encoder = new TextEncoder();

const sha256 = (bytes: Uint8Array | string) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

/**
 * The content hash E2B caches a `COPY` step's files under: sha256 over the
 * step, then each file's path, mode, size and content hash. Stable across
 * machines (no owners or timestamps).
 */
export const filesHash = (
  src: string,
  dest: string,
  files: ReadonlyArray<Pick<UploadFile, "path" | "mode" | "size" | "sha256">>,
): string => {
  const hash = crypto.createHash("sha256");
  hash.update(`COPY ${src} ${dest}`);
  for (const file of files) {
    hash.update(`${file.path}\0${file.mode}\0${file.size}\0${file.sha256}\0`);
  }
  return hash.digest("hex");
};

/** `files` as `COPY` steps: each file is its own upload, named by its content. */
const fileSteps = (files: ReadonlyArray<TemplateFile>) =>
  files.map((file) => {
    const bytes = typeof file.contents === "string" ? encoder.encode(file.contents) : file.contents;
    const upload: UploadFile = {
      path: `files/${sha256(bytes).slice(0, 16)}`,
      mode: file.mode ?? 0o644,
      size: bytes.byteLength,
      sha256: sha256(bytes),
      read: Effect.succeed(bytes),
    };
    const hash = filesHash(upload.path, file.path, [upload]);
    return {
      step: {
        type: "COPY",
        args: [upload.path, file.path, "", ""],
        filesHash: hash,
      } as PlannedStep,
      hash,
      upload,
    };
  });

/**
 * Plans a build: the lowered source (if any), then `env`, `files` and `run`
 * as E2B steps, hashed.
 */
export const planTemplateBuild = (spec: TemplateBuildSpec, lowered?: LoweredSource) =>
  Effect.gen(function* () {
    if (spec.image !== undefined && spec.fromTemplate !== undefined) {
      return yield* new E2BUnexpectedResponse({
        message: `template ${spec.name}: set one of image or fromTemplate`,
      });
    }
    const uploads = new Map<string, ReadonlyArray<UploadFile>>(lowered?.uploads ?? []);
    const files = fileSteps(spec.files ?? []);
    for (const file of files) uploads.set(file.hash, [file.upload]);
    const steps: PlannedStep[] = [
      ...(lowered?.steps ?? []),
      ...(spec.env && Object.keys(spec.env).length > 0
        ? [{ type: "ENV" as const, args: Object.entries(spec.env).flat() }]
        : []),
      ...files.map((file) => file.step),
      ...(spec.run ?? []).map((command) => ({ type: "RUN" as const, args: [command] })),
    ];
    const fromTemplate = spec.fromTemplate;
    const fromImage =
      fromTemplate !== undefined
        ? undefined
        : (lowered?.fromImage ?? spec.image ?? DEFAULT_BASE_IMAGE);
    const startCmd = spec.startCmd ?? lowered?.startCmd;

    const hash = sha256(
      JSON.stringify({
        fromImage,
        fromTemplate,
        steps,
        startCmd,
        readyCmd: spec.readyCmd,
        cpuCount: spec.cpuCount,
        memoryMB: spec.memoryMB,
        minFreeDiskMb: spec.minFreeDiskMb,
        registry: spec.registry === undefined ? undefined : Object.keys(spec.registry).sort(),
      }),
    );

    return {
      fromImage,
      fromTemplate,
      steps,
      startCmd,
      readyCmd: spec.readyCmd,
      uploads,
      hash,
    } satisfies TemplateBuildPlan;
  });

const registryOf = (registry: TemplateRegistry): templates.FromImageRegistry =>
  // The registry union is opaque on the wire: secrets are unwrapped here, at
  // the point of use, and never logged.
  "awsAccessKeyId" in registry
    ? {
        type: "aws",
        awsAccessKeyId: registry.awsAccessKeyId,
        awsSecretAccessKey: Redacted.value(registry.awsSecretAccessKey),
        awsRegion: registry.awsRegion,
      }
    : "serviceAccountJson" in registry
      ? { type: "gcp", serviceAccountJson: Redacted.value(registry.serviceAccountJson) }
      : {
          type: "registry",
          username: registry.username,
          password: Redacted.value(registry.password),
        };

/** Uploads one `COPY` context unless E2B already has it. */
const uploadContext = Effect.fn(function* (
  templateId: string,
  hash: string,
  files: ReadonlyArray<UploadFile>,
) {
  const link = yield* templates.getTemplateFileUploadLink({ templateID: templateId, hash });
  if (link.present) return;
  if (link.url === undefined) {
    return yield* new E2BUnexpectedResponse({
      message: `E2B returned no upload URL for context ${hash} of template ${templateId}`,
    });
  }
  const archive = yield* tarGzip(
    yield* Effect.forEach(files, (file) =>
      Effect.map(file.read, (contents) => ({ path: file.path, mode: file.mode, contents })),
    ),
  );
  const client = yield* HttpClient.HttpClient;
  const headers = Object.fromEntries(
    Object.entries(link.headers ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  // Raw HTTP: a presigned upload URL the API handed back, used as-is. The
  // body is sized (presigned PUTs reject chunked transfer encoding), and
  // carries only the headers E2B returned: the URL is signed without a
  // Content-Type, so sending one fails with SignatureDoesNotMatch.
  const response = yield* client
    .execute(
      HttpClientRequest.put(link.url).pipe(
        HttpClientRequest.bodyUint8Array(archive),
        HttpClientRequest.removeHeader("content-type"),
        HttpClientRequest.setHeaders(headers),
      ),
    )
    .pipe(Effect.retry({ times: 4, schedule: Schedule.exponential("500 millis") }));
  if (response.status < 200 || response.status >= 300) {
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new E2BUnexpectedResponse({
      message: `uploading build context ${hash} for template ${templateId} failed with HTTP ${response.status}: ${body.slice(0, 500)}`,
    });
  }
});

/** Polls a build until it is ready; fails with its reason and the tail of its logs. */
export const waitForBuild = Effect.fn(function* (templateId: string, buildId: string) {
  const status = yield* templates
    .getTemplateBuildStatus({ templateID: templateId, buildID: buildId })
    .pipe(
      Effect.repeat({
        // Image pulls and dependency installs take minutes; bounded at ~20 min.
        schedule: Schedule.spaced(Duration.seconds(3)),
        until: (info) => info.status === "ready" || info.status === "error",
        times: 400,
      }),
    );
  if (status.status !== "ready") {
    // `logs` is always empty on the current build path; `logEntries` has them.
    const logs = (status.reason?.logEntries ?? status.logEntries)
      .slice(-40)
      .map((entry) => entry.message);
    return yield* new TemplateBuildFailed({
      message: [
        `E2B template build ${buildId} failed: ${status.reason?.message ?? status.status}`,
        ...logs.slice(-15).map((line) => `  ${line}`),
      ].join("\n"),
      templateId,
      buildId,
      reason: status.reason?.message,
      logs,
    });
  }
  return status;
});

/** Runs a planned build to completion. */
export const runTemplateBuild = Effect.fn(function* (
  spec: TemplateBuildSpec,
  plan: TemplateBuildPlan,
) {
  const created = yield* templates.createTemplate({
    name: spec.name,
    tags: spec.tags === undefined ? undefined : [...spec.tags],
    cpuCount: spec.cpuCount,
    memoryMB: spec.memoryMB,
    minFreeDiskMb: spec.minFreeDiskMb,
  });
  yield* Effect.forEach(
    [...plan.uploads],
    ([hash, files]) => uploadContext(created.templateID, hash, files),
    { concurrency: 4, discard: true },
  );
  yield* templates.startTemplateBuild({
    templateID: created.templateID,
    buildID: created.buildID,
    fromImage: plan.fromImage,
    fromTemplate: plan.fromTemplate,
    fromImageRegistry: spec.registry === undefined ? undefined : registryOf(spec.registry),
    steps: plan.steps.map((step) => ({
      type: step.type,
      args: [...step.args],
      filesHash: step.filesHash,
      force: spec.force,
    })),
    startCmd: plan.startCmd,
    readyCmd: plan.readyCmd,
    force: spec.force,
  });
  yield* waitForBuild(created.templateID, created.buildID);
  return {
    templateId: created.templateID,
    buildId: created.buildID,
    names: created.names,
    aliases: created.aliases,
    tags: created.tags,
    public: created.public,
  } satisfies TemplateBuildResult;
});
