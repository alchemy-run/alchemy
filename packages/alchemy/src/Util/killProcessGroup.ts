import * as NodeChildProcess from "node:child_process";

/**
 * Synchronously, best-effort kill a child process's entire process group
 * (process tree on Windows). Safe to call from `exitHook` callbacks — it is
 * the last line of defense when the process is exiting abruptly (e.g. a
 * synchronous `process.exit` from a SIGTERM handler preempting Effect
 * finalizers) and scoped child-process finalizers will never run.
 */
export const killProcessGroup = (pid: number, signal: NodeJS.Signals) => {
  try {
    if (process.platform === "win32") {
      NodeChildProcess.execSync(`taskkill /pid ${pid} /T /F`);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // ignore errors during best-effort cleanup
  }
};
