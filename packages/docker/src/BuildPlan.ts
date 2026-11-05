import * as crypto from "node:crypto";
import { normalizeRelativePath, walkIgnoring, type WalkEntryType } from "alchemy/Util/Ignore";
import { sha256Object } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { selectDockerBuildContext } from "./BuildHash.ts";
import { Docker } from "./Docker.ts";
import { isInlineDockerfile } from "./Dockerfile.ts";
import * as DockerfileParser from "./DockerfileParser.ts";
import type {
  CopyInstruction,
  Instruction,
  InstructionName,
  ParsedDockerfile,
} from "./DockerfileParser.ts";
import {
  bundleMainProgram,
  type BundledImageSource,
  type DockerfileImageSource,
  type ImageSourceProps,
} from "./ImageSource.ts";
import { publishedRepoDigest, type ImageRegistry } from "./Registry.ts";

/**
 * A build plan: an image source (`image`, `context` + `dockerfile`, inline
 * `dockerfile`, plus an optional bundled `main`) resolved into data that any
 * builder can consume, Docker or not.
 *
 * Platforms with their own builders (E2B templates, Modal images, Daytona
 * snapshots) lower a plan into their build API; the Docker path can render
 * it back into a Dockerfile and build context. Every platform declares
 * {@link Capabilities}, and a Dockerfile it cannot build fails at plan time
 * with the offending lines, before any upload or remote build.
 */
export interface BuildPlan {
  /** Content hash of everything that determines the image: rebuild only when it changes. */
  readonly hash: string;
  /** Target platform, e.g. `linux/amd64`. */
  readonly platform: string;
  /** Every stage, including the generated `main` layer. */
  readonly dockerfile: ParsedDockerfile;
  /** The final stage's base: an image reference, an earlier stage's name, or `scratch`. */
  readonly base: string;
  /** Credentials for pulling a private base image. */
  readonly pull: ImageRegistry | undefined;
  /** The final stage's instructions. */
  readonly instructions: ReadonlyArray<Instruction>;
  /**
   * Files the build reads from its context: everything a `COPY`/`ADD`
   * source reaches (after `.dockerignore`), plus the bundled `main` under
   * {@link BUNDLE_DIR}. Paths are relative to the context, `/`-separated.
   */
  readonly files: ReadonlyArray<ContextFile>;
  /**
   * Build arguments (`ARG` values) the builder must pass. Empty when the
   * builder takes none ({@link Capabilities.buildArgs}): the values are then
   * written into the `ARG` defaults of {@link dockerfile}.
   */
  readonly args: Readonly<Record<string, string>>;
  /** BuildKit secrets, by id (`RUN --mount=type=secret,id=…`). */
  readonly secrets: Readonly<Record<string, Redacted.Redacted<string>>>;
  /** Instructions the platform ignores (see {@link Capabilities.instructions}). */
  readonly warnings: ReadonlyArray<string>;
}

/** A file in a plan's build context. */
export interface ContextFile {
  /** Context-relative, `/`-separated. */
  readonly path: string;
  /** Permission bits. */
  readonly mode: number;
  readonly size: number;
  /** Hex SHA-256 of the contents. */
  readonly sha256: string;
  readonly source:
    | { readonly _tag: "Path"; readonly absolutePath: string }
    | { readonly _tag: "Bytes"; readonly bytes: Uint8Array };
}

/**
 * What a builder supports. Anything not listed is supported.
 */
export interface Capabilities {
  /** The resource the plan is for, used in error messages, e.g. `"E2B.Template"`. */
  readonly target: string;
  /** More than one `FROM`, or `COPY --from`. @default true */
  readonly multiStage?: boolean;
  /** `RUN <<EOF` / `COPY <<EOF`. @default true */
  readonly heredocs?: boolean;
  /** `RUN --mount=…` (secrets, caches). @default true */
  readonly runMounts?: boolean;
  /** `ADD <url>`. @default true */
  readonly remoteAdd?: boolean;
  /**
   * Build arguments passed to the builder. When `false`, the plan writes
   * the values into the Dockerfile's `ARG` defaults instead. @default true
   */
  readonly buildArgs?: boolean;
  /** BuildKit secrets (`build.secrets`, `RUN --mount=type=secret`). @default true */
  readonly secrets?: boolean;
  /** Platforms the builder targets, also checked against `FROM --platform=`. @default any */
  readonly platforms?: ReadonlyArray<string>;
  /** Instructions the builder ignores (a warning) or rejects (an error). */
  readonly instructions?: Partial<Record<InstructionName, "ignored" | "unsupported">>;
}

/** One reason a builder cannot build a plan. */
export interface Violation {
  /** 1-based Dockerfile line; `0` for the generated `main` layer or the platform. */
  readonly line: number;
  readonly instruction: string;
  readonly reason: string;
}

/** The Dockerfile uses something the target builder cannot build. */
export class UnsupportedDockerfile extends Data.TaggedError("UnsupportedDockerfile")<{
  readonly target: string;
  readonly violations: ReadonlyArray<Violation>;
  readonly message: string;
}> {}

/** The image source cannot be planned (a missing file, an unresolved input, an inline Dockerfile that copies from a context). */
export class BuildPlanError extends Data.TaggedError("BuildPlanError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The context directory a plan's bundled `main` files live under. */
export const BUNDLE_DIR = "__alchemy__";

/** Default base for a `main` program with no environment: Docker Hub's bun image. */
export const DEFAULT_MAIN_BASE = "oven/bun:1";

export interface PlanOptions {
  readonly capabilities: Capabilities;
  /** @default "linux/amd64" */
  readonly platform?: string;
  /** Port a `main` program listens on; written to `ENV PORT`. */
  readonly port?: number;
  /**
   * Bootstrap wrapped around an Effect-native `main` (the host's virtual
   * entry). Omit it to bundle `main` as-is.
   */
  readonly bootstrap?: (importPath: string) => string;
  /** Credentials for pulling a private base image. */
  readonly pull?: ImageRegistry;
  /**
   * Dockerfile lines a host's bindings contribute, e.g. the clients of
   * `alchemy/Mount` capabilities (`mountInstallLines`). They go after the
   * final stage's own instructions and before the bundled `main`, so a
   * program change doesn't reinstall them.
   */
  readonly install?: ReadonlyArray<string>;
}

const isRemoteSource = (source: string) => /^(https?:\/\/|git@)/.test(source);
const isHeredocSource = (source: string) => source.startsWith("<<");

/** Sources that read from the build context (not another stage, a URL, or a heredoc). */
const contextSources = (instruction: CopyInstruction): string[] =>
  instruction.flags.some((flag) => flag.name === "from")
    ? []
    : instruction.sources.filter((source) => !isRemoteSource(source) && !isHeredocSource(source));

// ---------------------------------------------------------------------------
// COPY source matching (Go filepath.Match per segment, plus `**`)
// ---------------------------------------------------------------------------

const segmentPattern = (segment: string) =>
  new RegExp(
    `^${segment
      .replace(/[.+^${}()|\\]/g, "\\$&")
      .replace(/\[!/g, "[^")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")}$`,
  );

interface SourcePattern {
  readonly all: boolean;
  readonly segments: ReadonlyArray<string>;
  readonly matchers: ReadonlyArray<RegExp | "**">;
}

const compileSource = (source: string): SourcePattern => {
  const cleaned = normalizeRelativePath(source).replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = cleaned.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  return {
    all: segments.length === 0,
    segments,
    matchers: segments.map((segment) => (segment === "**" ? "**" : segmentPattern(segment))),
  };
};

const matchSegments = (
  path: ReadonlyArray<string>,
  matchers: ReadonlyArray<RegExp | "**">,
): boolean => {
  if (matchers.length === 0) return path.length === 0;
  const [head, ...rest] = matchers;
  if (head === "**") {
    for (let skip = 0; skip <= path.length; skip++) {
      if (matchSegments(path.slice(skip), rest)) return true;
    }
    return false;
  }
  return path.length > 0 && head!.test(path[0]!) && matchSegments(path.slice(1), rest);
};

/** The pattern names `path` or one of its directories (a directory copies its contents). */
const covers = (pattern: SourcePattern, path: string) => {
  if (pattern.all) return true;
  const segments = path.split("/");
  for (let length = 1; length <= segments.length; length++) {
    if (matchSegments(segments.slice(0, length), pattern.matchers)) return true;
  }
  return false;
};

/** A directory a walk must descend into: covered, or on the way to a match. */
const reaches = (pattern: SourcePattern, directory: string) => {
  if (covers(pattern, directory)) return true;
  const segments = directory.split("/");
  for (let index = 0; index < segments.length; index++) {
    const matcher = pattern.matchers[index];
    if (matcher === undefined) return false;
    if (matcher === "**") return true;
    if (!matcher.test(segments[index]!)) return false;
  }
  return true;
};

/** The context files one `COPY`/`ADD` reads. */
export const filesFor = (plan: BuildPlan, instruction: CopyInstruction): ContextFile[] => {
  const patterns = contextSources(instruction).map(compileSource);
  return plan.files.filter((file) => patterns.some((pattern) => covers(pattern, file.path)));
};

// ---------------------------------------------------------------------------
// planning
// ---------------------------------------------------------------------------

const hashFile = Effect.fn(function* (absolutePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const hasher = yield* Effect.sync(() => crypto.createHash("sha256"));
  yield* fs.stream(absolutePath).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        hasher.update(chunk);
      }),
    ),
  );
  return yield* Effect.sync(() => hasher.digest("hex"));
});

const hashBytes = (bytes: Uint8Array) =>
  Effect.sync(() => crypto.createHash("sha256").update(bytes).digest("hex"));

/** Walk only the directories some source can reach, and keep what `.dockerignore` keeps. */
const collectContextFiles = Effect.fn(function* (options: {
  readonly context: string;
  readonly dockerfile: string;
  readonly sources: ReadonlyArray<string>;
}) {
  if (options.sources.length === 0) return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const selection = yield* selectDockerBuildContext({
    context: options.context,
    dockerfile: options.dockerfile,
  });
  const patterns = options.sources.map(compileSource);

  const entries = yield* walkIgnoring({
    list: Effect.fn(function* (relativeDirectory: string) {
      const directory = path.join(selection.context, relativeDirectory);
      const names = yield* fs.readDirectory(directory);
      const children = yield* Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          const fullPath = path.join(directory, name);
          const childPath = relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`;
          if (Result.isSuccess(yield* Effect.result(fs.readLink(fullPath)))) {
            return { name, childPath, type: "SymbolicLink" as WalkEntryType };
          }
          const info = yield* fs.stat(fullPath);
          const type: WalkEntryType =
            info.type === "File" || info.type === "Directory" ? info.type : "Other";
          return { name, childPath, type };
        }),
      );
      return children.filter(
        (child) =>
          child.type !== "Directory" ||
          patterns.some((pattern) => reaches(pattern, child.childPath)),
      );
    }),
  });

  const files: ContextFile[] = [];
  for (const entry of entries) {
    if (entry.type !== "File" && entry.type !== "SymbolicLink") continue;
    if (!selection.includes(entry.path)) continue;
    if (!patterns.some((pattern) => covers(pattern, entry.path))) continue;
    const absolutePath = path.join(selection.context, entry.path);
    // Docker copies a symlink's target into the image when the link is named directly.
    const info = yield* fs.stat(absolutePath);
    if (info.type !== "File") continue;
    files.push({
      path: entry.path,
      mode: info.mode & 0o7777,
      size: Number(info.size),
      sha256: yield* hashFile(absolutePath),
      source: { _tag: "Path", absolutePath },
    });
  }
  return files;
});

const unsupported = (target: string, violations: ReadonlyArray<Violation>) =>
  new UnsupportedDockerfile({
    target,
    violations,
    message: [
      `${target} cannot build this Dockerfile:`,
      ...violations.map((violation) =>
        violation.line > 0
          ? `  line ${violation.line}: ${violation.instruction}: ${violation.reason}`
          : `  ${violation.instruction}: ${violation.reason}`,
      ),
    ].join("\n"),
  });

/** Check a parsed Dockerfile against a builder's capabilities. */
export const check = (
  dockerfile: ParsedDockerfile,
  capabilities: Capabilities,
  platform: string,
): { violations: Violation[]; warnings: string[] } => {
  const violations: Violation[] = [];
  const warnings: string[] = [];
  if (capabilities.platforms !== undefined && !capabilities.platforms.includes(platform)) {
    violations.push({
      line: 0,
      instruction: "platform",
      reason: `${platform} is not supported (supported: ${capabilities.platforms.join(", ")})`,
    });
  }
  if (capabilities.platforms !== undefined) {
    for (const stage of dockerfile.stages) {
      const pinned = stage.flags.find((flag) => flag.name === "platform")?.value;
      // `$BUILDPLATFORM`-style values resolve at build time, to the builder's own platform.
      if (pinned === undefined || pinned.includes("$")) continue;
      if (!capabilities.platforms.includes(pinned)) {
        violations.push({
          line: stage.line,
          instruction: "FROM --platform",
          reason: `${pinned} is not supported (supported: ${capabilities.platforms.join(", ")})`,
        });
      }
    }
  }
  if (capabilities.multiStage === false && dockerfile.stages.length > 1) {
    for (const stage of dockerfile.stages.slice(1)) {
      violations.push({
        line: stage.line,
        instruction: "FROM",
        reason: "multi-stage builds are not supported",
      });
    }
  }
  for (const stage of dockerfile.stages) {
    for (const instruction of stage.instructions) {
      const status = capabilities.instructions?.[instruction._tag];
      if (status === "unsupported") {
        violations.push({
          line: instruction.line,
          instruction: instruction._tag,
          reason: "not supported",
        });
      } else if (status === "ignored") {
        warnings.push(
          `${capabilities.target} ignores ${instruction._tag}${instruction.line > 0 ? ` (line ${instruction.line})` : ""}`,
        );
      }
      if (instruction._tag === "COPY" || instruction._tag === "ADD") {
        if (
          capabilities.multiStage === false &&
          instruction.flags.some((flag) => flag.name === "from")
        ) {
          violations.push({
            line: instruction.line,
            instruction: `${instruction._tag} --from`,
            reason: "multi-stage builds are not supported",
          });
        }
        if (capabilities.remoteAdd === false && instruction.sources.some(isRemoteSource)) {
          violations.push({
            line: instruction.line,
            instruction: instruction._tag,
            reason: "remote sources are not supported",
          });
        }
      }
      if (
        (instruction._tag === "RUN" || instruction._tag === "COPY" || instruction._tag === "ADD") &&
        capabilities.heredocs === false &&
        instruction.heredocs.length > 0
      ) {
        violations.push({
          line: instruction.line,
          instruction: `${instruction._tag} <<`,
          reason: "heredocs are not supported",
        });
      }
      if (
        instruction._tag === "RUN" &&
        capabilities.runMounts === false &&
        instruction.flags.some((flag) => flag.name === "mount")
      ) {
        violations.push({
          line: instruction.line,
          instruction: "RUN --mount",
          reason: "build mounts are not supported",
        });
      } else if (
        instruction._tag === "RUN" &&
        capabilities.secrets === false &&
        instruction.flags.some(
          (flag) => flag.name === "mount" && /(^|,)type=secret(,|$)/.test(flag.value ?? ""),
        )
      ) {
        violations.push({
          line: instruction.line,
          instruction: "RUN --mount=type=secret",
          reason: "build secrets are not supported",
        });
      }
    }
  }
  return { violations, warnings };
};

/** The generated layer that runs a bundled `main`: shared by every builder. */
const mainLayer = (port: number | undefined) =>
  [
    `WORKDIR /app`,
    `COPY ${BUNDLE_DIR}/ /app/`,
    ...(port === undefined ? [] : [`ENV PORT=${String(port)}`]),
    `ENTRYPOINT ["bun", "/app/index.mjs"]`,
  ].join("\n");

/** Synthesized instructions carry line 0: they are not in the user's Dockerfile. */
const synthesized = (instruction: Instruction): Instruction => ({ ...instruction, line: 0 });

/** Append generated instructions to the final stage. */
const appendToFinalStage = Effect.fn(function* (dockerfile: ParsedDockerfile, lines: string) {
  const layer = yield* DockerfileParser.parse(`FROM scratch\n${lines}\n`);
  const stages = [...dockerfile.stages];
  const final = stages.at(-1)!;
  stages[stages.length - 1] = {
    ...final,
    instructions: [...final.instructions, ...layer.stages[0]!.instructions.map(synthesized)],
  };
  return { ...dockerfile, stages } satisfies ParsedDockerfile;
});

/**
 * Write build argument values into the `ARG` defaults that declare them, for
 * builders that take no build arguments. Values are quoted so they are used
 * as given, the way `--build-arg` passes them (no `$` expansion).
 */
const bakeArgs = (
  dockerfile: ParsedDockerfile,
  args: Readonly<Record<string, string>>,
): ParsedDockerfile => {
  const escape = dockerfile.directives.escape ?? "\\";
  // A baked value is literal, so `$` is escaped too; a default that was
  // already there keeps its `$` references.
  const quote = (value: string, literal: boolean) =>
    `"${Array.from(value, (char) =>
      char === escape || char === '"' || (literal && char === "$") ? `${escape}${char}` : char,
    ).join("")}"`;
  const bake = <I extends Instruction>(instruction: I): I => {
    if (instruction._tag !== "ARG" || !instruction.vars.some(([name]) => name in args)) {
      return instruction;
    }
    const vars = instruction.vars.map(([name, value]) =>
      name in args ? ([name, args[name]] as const) : ([name, value] as const),
    );
    const raw = `ARG ${vars
      .map(([name, value]) =>
        value === undefined ? name : `${name}=${quote(value, name in args)}`,
      )
      .join(" ")}`;
    return { ...instruction, vars, raw };
  };
  return {
    ...dockerfile,
    globalArgs: dockerfile.globalArgs.map(bake),
    stages: dockerfile.stages.map((stage) => ({
      ...stage,
      instructions: stage.instructions.map(bake),
    })),
  };
};

/**
 * Resolve an image source into a {@link BuildPlan} for one builder.
 */
export const plan = Effect.fn(function* (source: ImageSourceProps, options: PlanOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = options.platform ?? "linux/amd64";
  const main = "main" in source ? (source as BundledImageSource) : undefined;
  const image = "image" in source ? source.image : undefined;
  const dockerfileProp = "dockerfile" in source ? source.dockerfile : undefined;
  const contextProp = "context" in source ? source.context : undefined;
  const build = main === undefined ? (source as DockerfileImageSource).build : undefined;

  // 1. The environment's Dockerfile text, and where its context lives.
  let text: string;
  let context: { context: string; dockerfile: string } | undefined;
  if (dockerfileProp !== undefined && isInlineDockerfile(dockerfileProp)) {
    if (typeof dockerfileProp.content !== "string") {
      return yield* new BuildPlanError({
        message: "inline dockerfile content is not resolved yet",
      });
    }
    text = dockerfileProp.content;
  } else if (dockerfileProp !== undefined || contextProp !== undefined) {
    const contextDir = path.resolve(contextProp ?? ".");
    const dockerfile =
      dockerfileProp !== undefined
        ? path.resolve(dockerfileProp)
        : path.join(contextDir, "Dockerfile");
    text = yield* fs
      .readFileString(dockerfile)
      .pipe(
        Effect.mapError(
          (cause) => new BuildPlanError({ message: `cannot read ${dockerfile}`, cause }),
        ),
      );
    context = { context: contextDir, dockerfile };
  } else if (image !== undefined) {
    text = `FROM ${image}\n`;
  } else if (main !== undefined) {
    text = `FROM ${DEFAULT_MAIN_BASE}\n`;
  } else {
    return yield* new BuildPlanError({
      message: "an image source needs `image`, `dockerfile`, `context`, or `main`",
    });
  }

  let dockerfile = yield* DockerfileParser.parse(text);

  // 2. Install lines from the host's bindings, then a bundled `main`, become
  //    generated layers on the final stage.
  if (options.install !== undefined && options.install.length > 0) {
    dockerfile = yield* appendToFinalStage(dockerfile, options.install.join("\n"));
  }
  const files: ContextFile[] = [];
  if (main !== undefined) {
    const bundled = yield* bundleMainProgram({
      source: main,
      isExternal: options.bootstrap === undefined,
      bootstrap: options.bootstrap ?? ((importPath) => importPath),
    });
    for (const file of bundled.files) {
      files.push({
        path: `${BUNDLE_DIR}/${normalizeRelativePath(file.path)}`,
        mode: 0o644,
        size: file.content.byteLength,
        sha256: yield* hashBytes(file.content),
        source: { _tag: "Bytes", bytes: file.content },
      });
    }
    dockerfile = yield* appendToFinalStage(dockerfile, mainLayer(options.port));
  }

  // 3. Context files every COPY/ADD reaches.
  const sources = dockerfile.stages.flatMap((stage) =>
    stage.instructions.flatMap((instruction) =>
      (instruction._tag === "COPY" || instruction._tag === "ADD") && instruction.line > 0
        ? contextSources(instruction)
        : [],
    ),
  );
  if (sources.length > 0) {
    if (context === undefined) {
      return yield* new BuildPlanError({
        message: `an inline dockerfile cannot COPY from a build context (${sources.join(", ")}); use \`context\` + a Dockerfile path`,
      });
    }
    files.push(...(yield* collectContextFiles({ ...context, sources })));
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // 4. What the builder can do.
  const secrets = build?.secrets ?? {};
  const { violations, warnings } = check(dockerfile, options.capabilities, platform);
  if (options.capabilities.secrets === false && Object.keys(secrets).length > 0) {
    violations.push({
      line: 0,
      instruction: "build.secrets",
      reason: "build secrets are not supported",
    });
  }
  if (violations.length > 0) {
    return yield* unsupported(options.capabilities.target, violations);
  }

  // 5. A builder that takes no build arguments gets them as `ARG` defaults.
  let args = build?.args ?? {};
  if (options.capabilities.buildArgs === false && Object.keys(args).length > 0) {
    dockerfile = bakeArgs(dockerfile, args);
    args = {};
  }

  const final = dockerfile.stages.at(-1)!;
  const hash = (yield* sha256Object({
    platform,
    dockerfile: DockerfileParser.render(dockerfile),
    files: files.map((file) => [file.path, file.mode, file.sha256]),
    args,
    secrets: Object.keys(secrets).sort(),
    pull: options.pull?.server,
  })).slice(0, 32);

  return {
    hash,
    platform,
    dockerfile,
    base: final.image,
    pull: options.pull,
    instructions: final.instructions,
    files,
    args,
    secrets,
    warnings,
  } satisfies BuildPlan;
});

/** A context file's contents. */
export const readContextFile = Effect.fn(function* (file: ContextFile) {
  if (file.source._tag === "Bytes") return file.source.bytes;
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFile(file.source.absolutePath);
});

/** The plan as Dockerfile text. */
export const render = (plan: BuildPlan): string => DockerfileParser.render(plan.dockerfile);

/** The plan as one entry per instruction (for APIs that take a list of Dockerfile commands). */
export const renderLines = (plan: BuildPlan): string[] =>
  DockerfileParser.renderLines(plan.dockerfile);

/**
 * The argv the image starts with, from the final stage's `ENTRYPOINT` and
 * `CMD` (Docker's rules: a shell-form `ENTRYPOINT` ignores `CMD`).
 * `undefined` when the final stage sets neither (the base image's applies).
 */
export const startCommand = (plan: BuildPlan): ReadonlyArray<string> | undefined => {
  const entrypoint = plan.instructions.findLast((instruction) => instruction._tag === "ENTRYPOINT");
  const cmd = plan.instructions.findLast((instruction) => instruction._tag === "CMD");
  const argv = (instruction: Instruction | undefined) =>
    instruction === undefined || !("command" in instruction)
      ? undefined
      : instruction.command.form === "exec"
        ? instruction.command.argv
        : ["/bin/sh", "-c", instruction.command.script];
  if (entrypoint !== undefined && "command" in entrypoint) {
    return entrypoint.command.form === "shell"
      ? argv(entrypoint)
      : [...entrypoint.command.argv, ...(argv(cmd) ?? [])];
  }
  return argv(cmd);
};

/**
 * Check Dockerfile text against a builder's capabilities, without reading a
 * build context or bundling anything: usable where there is no filesystem
 * (a Worker creating images at run time). Returns the warnings.
 */
export const checkContent = Effect.fn(function* (
  text: string,
  options: Pick<PlanOptions, "capabilities" | "platform">,
) {
  const dockerfile = yield* DockerfileParser.parse(text);
  const { violations, warnings } = check(
    dockerfile,
    options.capabilities,
    options.platform ?? "linux/amd64",
  );
  if (violations.length > 0) {
    return yield* unsupported(options.capabilities.target, violations);
  }
  return warnings;
});

/** Where {@link push} publishes a plan. */
export interface PushTarget {
  /** Repository to push to, without a tag, e.g. `ghcr.io/acme/agent`. The plan's hash is the tag. */
  readonly repository: string;
  /** Credentials for the registry the repository lives in. */
  readonly push: ImageRegistry;
}

/**
 * Build a plan with the local Docker engine and push it, for platforms that
 * only pull images (Archil). Tagged with the plan's hash, so an unchanged
 * plan pushes the same tag. Returns the pushed reference, `repository@digest`
 * when the registry reports a digest, else `repository:hash`.
 */
export const push = Effect.fn(function* (plan: BuildPlan, target: PushTarget) {
  const docker = yield* Docker;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-build-plan-" });
  yield* Effect.forEach(
    plan.files,
    Effect.fn(function* (file) {
      const fullPath = path.join(context, file.path);
      yield* fs.makeDirectory(path.dirname(fullPath), { recursive: true });
      yield* fs.writeFile(fullPath, yield* readContextFile(file));
      yield* fs.chmod(fullPath, file.mode);
    }),
    { concurrency: 16 },
  );
  const dockerfile = path.join(context, "Dockerfile.alchemy");
  yield* fs.writeFileString(dockerfile, render(plan));
  const ref = `${target.repository}:${plan.hash}`;
  const output = yield* docker.image.build(
    {
      context,
      file: dockerfile,
      tag: ref,
      platform: plan.platform,
      "build-arg": { ...plan.args },
      secrets: { ...plan.secrets },
      credentials: plan.pull,
    },
    undefined,
    target.push,
  );
  // buildx `--push` exports straight from BuildKit, so the image may not be
  // in the local store to inspect.
  const inspected = yield* Effect.result(docker.image.inspect(ref));
  const pinned = publishedRepoDigest(
    ref,
    output,
    Result.isSuccess(inspected) ? inspected.success.RepoDigests : undefined,
  );
  return { imageRef: pinned ?? ref };
});
