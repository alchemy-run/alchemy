import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";

/** Open a URL in the platform's default browser without invoking a shell. */
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
    yield* handle.exitCode;
  }).pipe(Effect.scoped);
