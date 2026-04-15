import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/**
 * Open a URL in the user's default browser.
 *
 * On Windows, uses rundll32's FileProtocolHandler — a built-in shim that
 * opens URLs in the default browser. It accepts the URL as a direct
 * argument (no shell, no quoting of `&`). cmd.exe `start` would treat
 * `&` in OAuth URLs as a command separator, and `explorer.exe` treats
 * its arg as a path.
 */
export const openUrl = (
  url: string,
): Effect.Effect<void, unknown, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const [cmd, args] =
      process.platform === "win32"
        ? (["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const)
        : process.platform === "darwin"
          ? (["open", [url]] as const)
          : (["xdg-open", [url]] as const);
    const handle = yield* ChildProcess.make(cmd, [...args], { shell: false });
    yield* handle.exitCode;
  }).pipe(Effect.scoped);
