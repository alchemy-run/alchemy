/**
 * Lowers an image source (`image`, `dockerfile` + `context`, `main`) to E2B
 * build steps through `@alchemy.run/docker/BuildPlan`.
 *
 * E2B does not run `docker build`: its builder takes a base image plus a
 * list of steps (`RUN`, `COPY`, `ENV`, `WORKDIR`, `USER`) and a start
 * command. `BuildPlan.plan` parses the Dockerfile, bundles `main`, collects
 * the context files every `COPY` reads, and rejects what E2B's builder
 * cannot run ({@link E2BCapabilities}). This module maps the plan's final
 * stage onto E2B's steps, one `COPY` step and upload per source.
 *
 * Like E2B's own SDK, the build starts as `root` in `/` and ends as `user`
 * in `/home/user` unless the Dockerfile sets `USER` / `WORKDIR` itself.
 *
 * Deploy-time only: `BuildPlan` bundles and reads the filesystem.
 */
import * as BuildPlan from "@alchemy.run/docker/BuildPlan";
import type { ImageSourceProps } from "@alchemy.run/docker/ImageSource";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { UnsupportedDockerfileInstruction } from "../Errors.ts";
import {
  filesHash,
  type LoweredSource,
  type PlannedStep,
  type UploadFile,
} from "./TemplateBuild.ts";

/** What E2B's template builder can build. */
export const E2BCapabilities: BuildPlan.Capabilities = {
  target: "E2B.Template",
  multiStage: false,
  heredocs: false,
  runMounts: false,
  remoteAdd: false,
  platforms: ["linux/amd64"],
  // E2B's builder takes no build args or build secrets: arg values are
  // written into the steps, and secret mounts fail at plan.
  buildArgs: false,
  secrets: false,
  instructions: {
    SHELL: "unsupported",
    EXPOSE: "ignored",
    LABEL: "ignored",
    VOLUME: "ignored",
    HEALTHCHECK: "ignored",
    STOPSIGNAL: "ignored",
    ONBUILD: "ignored",
    MAINTAINER: "ignored",
  },
};

/** `$VAR`, `${VAR}`, `${VAR:-default}` and `${VAR:+alt}` from ARG/ENV values, as Docker expands them. */
export const substitute = (text: string, vars: ReadonlyMap<string, string>): string =>
  text.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([-+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (
      _,
      braced: string | undefined,
      op: string | undefined,
      word: string | undefined,
      bare: string | undefined,
    ) => {
      const name = braced ?? bare!;
      const value = vars.get(name);
      if (op === "-") return value !== undefined && value !== "" ? value : (word ?? "");
      if (op === "+") return value !== undefined && value !== "" ? (word ?? "") : "";
      return value ?? "";
    },
  );

const shellQuote = (word: string) =>
  /^[A-Za-z0-9_\-./=:@%+,]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

/** An exec-form argv as one shell command, for E2B's string steps. */
export const shellCommand = (argv: ReadonlyArray<string>) => argv.map(shellQuote).join(" ");

/**
 * Lowers a plan's final stage to E2B steps. `args` override `ARG` defaults,
 * like `docker build --build-arg`. An `ARG` becomes an `ENV` step, as in
 * E2B's SDK, so `RUN` steps read it.
 */
export const lowerPlan = (plan: BuildPlan.BuildPlan, args: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const fail = (message: string, line: number) =>
      Effect.fail(new UnsupportedDockerfileInstruction({ message, line }));
    /** An ARG's value: the build arg, else its default, else (in a stage) the global value. */
    const argValue = (
      name: string,
      defaultValue: string | undefined,
      vars: ReadonlyMap<string, string>,
      inherited?: string,
    ) => args[name] ?? (defaultValue !== undefined ? substitute(defaultValue, vars) : inherited);

    const global = new Map<string, string>();
    for (const arg of plan.dockerfile.globalArgs) {
      for (const [name, defaultValue] of arg.vars) {
        const value = argValue(name, defaultValue, global);
        if (value !== undefined) global.set(name, value);
      }
    }
    const fromImage = substitute(plan.base, global);
    // Global ARGs only parameterise FROM; the stage sees the ones it redeclares.
    const vars = new Map<string, string>();

    const steps: PlannedStep[] = [
      { type: "USER", args: ["root"] },
      { type: "WORKDIR", args: ["/"] },
    ];
    const uploads = new Map<string, ReadonlyArray<UploadFile>>();
    let userChanged = false;
    let workdirChanged = false;

    for (const instruction of plan.instructions) {
      switch (instruction._tag) {
        case "ARG": {
          const set: string[] = [];
          for (const [name, defaultValue] of instruction.vars) {
            const value = argValue(name, defaultValue, vars, global.get(name));
            if (value === undefined) continue;
            vars.set(name, value);
            set.push(name, value);
          }
          if (set.length > 0) steps.push({ type: "ENV", args: set });
          break;
        }
        case "ENV": {
          const pairs = instruction.vars.map(
            ([name, value]) => [name, substitute(value, vars)] as const,
          );
          for (const [name, value] of pairs) vars.set(name, value);
          steps.push({ type: "ENV", args: pairs.flat() });
          break;
        }
        case "RUN":
          steps.push({
            type: "RUN",
            args: [
              instruction.command.form === "exec"
                ? shellCommand(instruction.command.argv)
                : instruction.command.script,
            ],
          });
          break;
        case "COPY":
        case "ADD": {
          const flag = (name: string) =>
            instruction.flags.find((candidate) => candidate.name === name)?.value ?? "";
          const dest = substitute(instruction.destination, vars);
          for (const raw of instruction.sources) {
            const src = substitute(raw, vars);
            const files = BuildPlan.filesFor(plan, { ...instruction, sources: [src] });
            if (files.length === 0) {
              return yield* fail(
                `${instruction._tag} ${src} matches no files in the build context`,
                instruction.line,
              );
            }
            const upload = files.map((file): UploadFile => ({
              path: file.path,
              mode: file.mode,
              size: file.size,
              sha256: file.sha256,
              read: BuildPlan.readContextFile(file).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
              ),
            }));
            const hash = filesHash(src, dest, upload);
            uploads.set(hash, upload);
            steps.push({
              type: "COPY",
              args: [src, dest, substitute(flag("chown"), vars), flag("chmod")],
              filesHash: hash,
            });
          }
          break;
        }
        case "WORKDIR":
          steps.push({ type: "WORKDIR", args: [substitute(instruction.value, vars)] });
          workdirChanged = true;
          break;
        case "USER":
          steps.push({ type: "USER", args: [substitute(instruction.value, vars)] });
          userChanged = true;
          break;
        // CMD / ENTRYPOINT are the start command; the rest are ignored
        // (BuildPlan rejected what E2B does not support).
        default:
          break;
      }
    }

    if (!userChanged) steps.push({ type: "USER", args: ["user"] });
    if (!workdirChanged) steps.push({ type: "WORKDIR", args: ["/home/user"] });

    const argv = BuildPlan.startCommand(plan);
    return {
      fromImage,
      steps,
      uploads,
      startCmd: argv === undefined ? undefined : shellCommand(argv),
    } satisfies LoweredSource;
  });

export interface PlanSourceOptions {
  /** Port a `main` program listens on. */
  readonly port?: number;
  /** Bootstrap wrapped around an Effect-native `main`. */
  readonly bootstrap?: (importPath: string) => string;
  /** `ARG` values. */
  readonly args?: Readonly<Record<string, string>>;
  /** Install lines from the program's mount capabilities (`alchemy/Mount`). */
  readonly install?: ReadonlyArray<string>;
}

/** Plans an image source with E2B's capabilities and lowers it to E2B steps. */
export const planSource = (source: ImageSourceProps, options: PlanSourceOptions = {}) =>
  Effect.gen(function* () {
    const plan = yield* BuildPlan.plan(source, {
      capabilities: E2BCapabilities,
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.bootstrap !== undefined ? { bootstrap: options.bootstrap } : {}),
      ...(options.install !== undefined && options.install.length > 0
        ? { install: options.install }
        : {}),
    });
    for (const warning of plan.warnings) yield* Effect.logDebug(warning);
    return yield* lowerPlan(plan, { ...plan.args, ...options.args });
  });
