import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Path from "effect/Path";
import type { PlatformError, SystemError } from "effect/PlatformError";
import { BadArgument } from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { ScopedPlanStatusSession } from "../Cli/Cli.ts";
import { isNonInteractive } from "../Util/interactive.ts";

export interface CommandProps {
  /**
   * The command to run.
   */
  command: string;
  /**
   * Working directory for the command. Defaults to `process.cwd()`.
   */
  cwd?: string;
  /**
   * Whether to run the command in a shell.
   * @default false
   */
  shell?: boolean;
  /**
   * Extra environment variables passed to the command on top of `process.env`.
   */
  env?: Record<string, string | Redacted.Redacted<string>>;
}

export class UnexpectedExit extends Data.TaggedError("UnexpectedExit")<{
  exitCode: number;
  stderr: string;
}> {
  override get message() {
    return `The command exited with code ${this.exitCode}. Standard error output: ${this.stderr}`;
  }
}

export class OutdirNotFound extends Data.TaggedError("OutdirNotFound")<{
  outdir: string;
}> {
  override get message() {
    return `The output directory "${this.outdir}" does not exist.`;
  }
}

export class CommandError extends Data.TaggedError("CommandError")<{
  command: string;
  reason: SystemError | BadArgument | UnexpectedExit | OutdirNotFound;
  cause?: unknown;
}> {
  constructor({
    command,
    reason,
  }: {
    command: string;
    reason: SystemError | BadArgument | UnexpectedExit | OutdirNotFound;
  }) {
    if ("cause" in reason) {
      super({ command, reason, cause: reason.cause });
    } else {
      super({ command, reason });
    }
  }

  override get message() {
    return `Failed to execute command "${this.command}": ${this.reason.message}`;
  }
}

export const Command = (module: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const pipe = (
      stream: Stream.Stream<Uint8Array, PlatformError>,
      tap: (chunk: string) => Effect.Effect<void>,
    ) =>
      stream.pipe(
        Stream.decodeText,
        Stream.tapSink(
          Sink.make<string>()(flow(Stream.splitLines, Stream.runForEach(tap))),
        ),
        Stream.mkString,
      );
    const mapPlatformError = (command: string) =>
      Effect.mapError((error: PlatformError | CommandError) =>
        error._tag === "CommandError"
          ? error
          : new CommandError({
              command,
              reason: error.reason,
            }),
      );

    const parseCommand = (
      props: CommandProps,
    ): Effect.Effect<{ bin: string; args: string[] }, CommandError> => {
      if (props.shell) {
        return Effect.succeed({ bin: props.command, args: [] });
      }
      const [bin, ...args] = props.command
        .split(/(\s+)/)
        .filter((part) => !!part.trim());

      if (!bin) {
        return Effect.fail(
          new CommandError({
            command: props.command,
            reason: new BadArgument({
              module,
              method: props.command,
              description: "Invalid command",
            }),
          }),
        );
      }
      return Effect.succeed({ bin, args });
    };

    const spawn = (props: CommandProps) =>
      parseCommand(props).pipe(
        Effect.flatMap(({ bin, args }) =>
          spawner.spawn(
            ChildProcess.make(bin, args, {
              cwd: path.resolve(props.cwd ?? process.cwd()),
              shell: props.shell ?? false,
              env: Object.fromEntries(
                Object.entries(props.env ?? {}).map(([k, v]) => [
                  k,
                  Redacted.isRedacted(v) ? Redacted.value(v) : v,
                ]),
              ),
              extendEnv: true,
              stdin: isNonInteractive() ? "ignore" : "inherit",
              stdout: "pipe",
              stderr: "pipe",
              detached: false,
            }),
          ),
        ),
        mapPlatformError(props.command),
      );

    return {
      spawn,
      run: (props: CommandProps, session: ScopedPlanStatusSession) =>
        spawn(props).pipe(
          Effect.flatMap((child) =>
            Effect.all(
              {
                exitCode: child.exitCode,
                stdout: pipe(child.stdout, session.note),
                stderr: pipe(child.stderr, session.note),
              },
              { concurrency: "unbounded" },
            ).pipe(mapPlatformError(props.command)),
          ),
          Effect.tap(({ exitCode, stderr }) =>
            exitCode !== 0
              ? Effect.fail(
                  new CommandError({
                    command: props.command,
                    reason: new UnexpectedExit({
                      exitCode,
                      stderr,
                    }),
                  }),
                )
              : Effect.void,
          ),
        ),
    };
  });
