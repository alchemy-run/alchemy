/**
 * Takes a snapshot: boots a template, runs setup commands in it, snapshots
 * it, and always kills the setup sandbox. Shared by the `E2B.Snapshot`
 * resource and the runtime `E2B.CreateSnapshot` client.
 */
import { sandboxConnectionFor } from "@distilled.cloud/e2b";
import * as process from "@distilled.cloud/e2b/process";
import * as sandboxes from "@distilled.cloud/e2b/sandboxes";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { SnapshotSetupFailed } from "../Errors.ts";

export interface SnapshotSetup {
  /** The template to boot: an id or name. */
  readonly template: string;
  /** Shell commands run in order before the snapshot is taken. */
  readonly run: ReadonlyArray<string>;
  readonly envs?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Capture memory as well as the filesystem. @default true */
  readonly memory?: boolean;
  /** How long the setup sandbox may run, in seconds. @default 900 */
  readonly timeout?: number;
}

/** Boots the template, runs the setup, snapshots it, and always kills the setup sandbox. */
export const takeSnapshot = Effect.fn(function* (name: string, props: SnapshotSetup) {
  return yield* Effect.acquireUseRelease(
    sandboxes.createSandbox({ templateID: props.template, timeout: props.timeout ?? 900 }),
    (sandbox) =>
      Effect.gen(function* () {
        for (const command of props.run) {
          const result = yield* process
            .startProcess({
              process: {
                cmd: "/bin/bash",
                args: ["-l", "-c", command],
                ...(props.envs ? { envs: props.envs } : {}),
                ...(props.cwd ? { cwd: props.cwd } : {}),
              },
            })
            .pipe(
              Stream.runFold(
                () => ({ exitCode: -1, stderr: "" }),
                (acc, event) =>
                  event._tag === "End"
                    ? { ...acc, exitCode: event.exitCode }
                    : event._tag === "Stderr"
                      ? {
                          ...acc,
                          stderr: (acc.stderr + new TextDecoder().decode(event.data)).slice(-4000),
                        }
                      : acc,
              ),
              Effect.provide(sandboxConnectionFor(sandbox)),
            );
          if (result.exitCode !== 0) {
            return yield* new SnapshotSetupFailed({
              message: `snapshot ${name}: \`${command}\` exited with ${result.exitCode}`,
              command,
              exitCode: result.exitCode,
              stderr: result.stderr,
            });
          }
        }
        return yield* sandboxes.createSandboxSnapshot({
          sandboxID: sandbox.sandboxID,
          name,
          memory: props.memory ?? true,
        });
      }),
    (sandbox) => Effect.ignore(sandboxes.deleteSandbox({ sandboxID: sandbox.sandboxID })),
  );
});
