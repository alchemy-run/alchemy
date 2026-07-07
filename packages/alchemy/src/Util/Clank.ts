import * as p from "@clack/prompts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";

export class PromptCancelled extends Data.TaggedError("PromptCancelled") {}
export const retryIfCancelled = Effect.retry({
  while: (e: unknown) => e instanceof PromptCancelled,
});

/**
 * Wraps a clack prompt (which returns a `Promise<T | symbol>` where the
 * symbol indicates user cancellation) in an Effect.
 *
 * Returns `undefined` if the user cancels (Ctrl+C / Escape).
 *
 * Uses `Effect.callback` so fiber interruption propagates via the abort
 * signal to any async resources we own; the clack prompt itself is left
 * to resolve — its result is ignored after interruption.
 */
export const prompt = <T>(
  fn: () => Promise<T | symbol>,
): Effect.Effect<T, PromptCancelled> =>
  Effect.callback<T, PromptCancelled>((resume, signal) => {
    let settled = false;
    fn().then(
      (result) => {
        if (settled || signal.aborted) return;
        settled = true;
        if (p.isCancel(result)) {
          resume(Effect.fail(new PromptCancelled()));
        } else {
          resume(Effect.succeed(result as T));
        }
      },
      (err) => {
        if (settled || signal.aborted) return;
        settled = true;
        resume(Effect.die(err));
      },
    );
  });

export const success = (str: string) => Effect.sync(() => p.log.success(str));
export const warn = (str: string) => Effect.sync(() => p.log.warn(str));
export const error = (str: string) => Effect.sync(() => p.log.error(str));
export const info = (str: string) => Effect.sync(() => p.log.info(str));
export const text = (opts: p.TextOptions) => prompt(() => p.text(opts));
export const password = (opts: p.PasswordOptions) =>
  prompt(() => p.password(opts));
export const select = <Value>(opts: p.SelectOptions<Value>) =>
  prompt(() => p.select<Value>(opts));
export const confirm = (opts: p.ConfirmOptions) =>
  prompt(() => p.confirm(opts));
export const multiselect = <Value>(opts: p.MultiSelectOptions<Value>) =>
  prompt(() => p.multiselect<Value>(opts));

/**
 * Open a URL in the user's default browser.
 *
 * On Windows, uses rundll32's FileProtocolHandler — a built-in shim that
 * opens URLs in the default browser. It accepts the URL as a direct
 * argument (no shell, no quoting of `&`). cmd.exe `start` would treat
 * `&` in OAuth URLs as a command separator, and `explorer.exe` treats
 * its arg as a path.
 */
export const openUrl = (url: string) =>
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

// Chromium-family browsers share the same AppleScript dictionary.
const CHROMIUM_BROWSERS = [
  "Google Chrome",
  "Arc",
  "Brave Browser",
  "Microsoft Edge",
  "Dia",
  "Chromium",
];

const chromiumFocusScript = (app: string, url: string) => `
if application "${app}" is running then
  tell application "${app}"
    repeat with w in windows
      set tIdx to 1
      repeat with t in tabs of w
        if URL of t starts with "${url}" then
          set active tab index of w to tIdx
          set index of w to 1
          activate
          return
        end if
        set tIdx to tIdx + 1
      end repeat
    end repeat
  end tell
end if
error "no tab"`;

const safariFocusScript = (url: string) => `
if application "Safari" is running then
  tell application "Safari"
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t starts with "${url}" then
          set current tab of w to t
          set index of w to 1
          activate
          return
        end if
      end repeat
    end repeat
  end tell
end if
error "no tab"`;

/**
 * Bring an already-open browser tab showing `url` (prefix match) to the
 * front — the "reuse the existing dashboard tab" counterpart to `openUrl`.
 *
 * Best-effort, macOS only: probes running browsers via AppleScript (a
 * browser that is not running is never launched; one that is not
 * installed fails compilation — both surface as a non-zero exit that we
 * skip past). Returns whether a tab was focused. Callers should treat
 * `false` as "the tab may exist but could not be raised" — NOT a cue to
 * open a duplicate.
 */
export const focusUrl = (url: string) =>
  Effect.gen(function* () {
    if (process.platform !== "darwin") {
      return false;
    }
    const scripts = [
      ...CHROMIUM_BROWSERS.map((app) => chromiumFocusScript(app, url)),
      safariFocusScript(url),
    ];
    for (const script of scripts) {
      const code = yield* Effect.gen(function* () {
        const handle = yield* ChildProcess.make("osascript", ["-e", script], {
          shell: false,
          stdout: "ignore",
          stderr: "ignore",
        });
        return yield* handle.exitCode;
      }).pipe(
        Effect.scoped,
        // never stall the caller on a macOS automation-permission prompt
        Effect.timeout("3 seconds"),
        Effect.orElseSucceed(() => 1),
      );
      if (code === 0) {
        return true;
      }
    }
    return false;
  });
