import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess } from "effect/unstable/process";
import { BrowserOpenFailed } from "./errors.ts";

/**
 * Open a URL in the platform's default browser without invoking a shell.
 *
 * Fails with {@link BrowserOpenFailed} when the launcher exits non-zero (e.g.
 * `xdg-open` with no handler installed). Some `xdg-open` configurations block
 * until the browser itself exits — a launcher still running after a short
 * grace period is treated as a successful launch rather than awaited.
 */
export const openUrl = (url: string) =>
  Effect.gen(function* () {
    const [command, args] =
      process.platform === "win32"
        ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    const handle = yield* ChildProcess.make(command, [...args], {
      shell: false,
    });
    const exitCode = yield* handle.exitCode.pipe(
      Effect.timeoutOption("3 seconds"),
    );
    if (Option.isSome(exitCode) && exitCode.value !== 0) {
      return yield* Effect.fail(
        new BrowserOpenFailed({ command, exitCode: exitCode.value }),
      );
    }
  }).pipe(Effect.scoped);
