import find from "find-process";
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Idempotently ensure a long-lived child is running with stdout/stderr -> files,
 * and mirror those logs to THIS process's console with persisted offsets.
 *
 * Use: await ensureLoggedChildAndMirror({ cmd: "vite dev" })
 */
export async function idempotentSpawn({
  cmd,
  cwd,
  env,
  stateFile = "state.json",
  overlapBytes = 0,
  resume = false,
  log = "log.txt",
  processName,
  extract,
  isSameProcess,
  quiet = false,
}: {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  log: string;
  stateFile?: string;
  overlapBytes?: number;
  resume?: boolean;
  isSameProcess?: (pid: number) => Promise<boolean>;
  processName?: string;
  extract?: (line: string) => string | undefined;
  /**
   * If true, the child's stdout and stderr will not be mirrored to this process's console.
   */
  quiet?: boolean;
}): Promise<{
  extracted: string | undefined;
  exit: () => Promise<void>;
}> {
  if (!processName && !isSameProcess) {
    throw new Error(
      "Either processName or isSameProcess must be provided to resume a process",
    );
  }

  const outPath = log;
  const errPath = outPath;
  await Promise.all([
    fsp.mkdir(path.dirname(stateFile), { recursive: true }),
    fsp.mkdir(path.dirname(log), { recursive: true }),
  ]);

  const { promise: extracted, resolve: resolveExtracted } =
    Promise.withResolvers<string | undefined>();

  if (!extract) {
    console.warn(
      "No extract function provided, will not return a value. This is probably a bug.",
    );
    resolveExtracted(undefined);
  }

  // ------------------------ helpers ------------------------

  function isPidAlive(pid: number) {
    if (!pid || Number.isNaN(pid)) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function writeJsonAtomic(file: string, data: any) {
    const dir = path.dirname(file);
    const tmp = path.join(
      dir,
      `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
    );
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, file); // atomic on POSIX
  }

  async function readJson(file: string) {
    try {
      return JSON.parse(await fsp.readFile(file, "utf8"));
    } catch {
      return undefined;
    }
  }

  async function spawnLoggedChild() {
    const out = await fsp.open(outPath, "a");
    const err = errPath === outPath ? out : await fsp.open(errPath, "a");

    // shell:true, NO args — pass a single command string
    const child = spawn(cmd, {
      shell: true,
      cwd,
      stdio: ["ignore", out.fd, err.fd], // stdout/stderr -> files (OS-level)
      env: { ...process.env, ...env },
      detached: false,
    });

    // Child now owns dup'd fds; close our handles.
    await out.close();
    if (err !== out) await err.close();

    // Persist PID into the shared state file
    const stateAll = (await readJson(stateFile)) ?? {};
    stateAll.pid = child.pid;
    await writeJsonAtomic(stateFile, stateAll);
    return child;
  }

  async function ensureChildRunning() {
    const stateAll = await readJson(stateFile);
    if (stateAll) {
      const pid = Number.parseInt(stateAll.pid, 10);
      if (isPidAlive(pid)) return pid;
      if (isSameProcess && (await isSameProcess(pid))) return pid;
      if (processName) {
        const processes = await find("pid", pid);
        const matches = processes.filter((p) => p.name.startsWith(processName));
        if (matches.length > 1) {
          console.warn(
            `Found multiple processes with PID ${pid}, using the first one`,
          );
        }
        if (matches[0]) return matches[0].pid;
      }
    }
    // not running, let's clear pid and state
    await removeStateFiles();
    const child = await spawnLoggedChild();
    assert(child.pid, "Child PID should be set");
    return child.pid;
  }

  // Follow a file from persisted offset and mirror to a sink (stdout/stderr)
  async function followFilePersisted(
    logPath: string,
    {
      stateKey,
      write = (buf: Buffer) => process.stdout.write(buf),
      chunkSize = 64 * 1024,
      tickMs = 100,
    }: {
      stateKey: string;
      write: (buf: Buffer) => boolean;
      chunkSize?: number;
      tickMs?: number;
    },
  ) {
    logPath = path.resolve(logPath);
    const stateAll = await readJson(stateFile);
    const state = stateAll[stateKey] || {};

    let fh = await fsp.open(logPath, "r");
    let st = await fh.stat();
    let ino = Number(st.ino ?? 0);
    let dev = Number(st.dev ?? 0);

    // Resume policy: if resume is enabled and same file, start at saved offset (with overlap); else start from end.
    let offset =
      resume &&
      state.ino === ino &&
      state.dev === dev &&
      typeof state.offset === "number"
        ? Math.max(0, Math.min(st.size, state.offset - overlapBytes))
        : st.size;

    let closed = false;

    async function persist() {
      try {
        const cur = await fh.stat();
        stateAll[stateKey] = {
          offset,
          ino: Number(cur.ino ?? ino),
          dev: Number(cur.dev ?? dev),
          size: cur.size,
          mtimeMs: cur.mtimeMs,
        };
        await writeJsonAtomic(stateFile, stateAll);
      } catch {
        // If the file vanished mid-rotation, we'll catch up on the next event.
      }
    }

    async function drain() {
      while (true) {
        const cur = await fh.stat().catch(() => null);
        if (!cur) break;

        if (cur.size < offset) offset = 0; // truncated

        if (offset > 0 && extract) {
          // read from start to offset
          const fullBuffer = Buffer.allocUnsafe(offset);
          await fh.read({
            position: 0,
            buffer: fullBuffer,
            length: offset,
          });
          const content = fullBuffer.toString("utf8");
          const lines = content.split("\n");
          for (const line of lines) {
            const extracted = extract(line);
            if (extracted) {
              resolveExtracted(extracted);
              break;
            }
          }
        }

        const toRead = Math.min(chunkSize, cur.size - offset);
        if (toRead <= 0) break;

        const { bytesRead, buffer } = await fh.read({
          position: offset,
          buffer: Buffer.allocUnsafe(toRead),
          length: toRead,
        });
        if (!bytesRead) break;

        offset += bytesRead;
        write(buffer.subarray(0, bytesRead));
      }
      await persist();
    }

    await drain();

    const watcher = fs.watch(logPath, async () => {
      if (closed) return;
      try {
        const cur = await fh.stat();
        const curIno = Number(cur.ino ?? 0);
        const curDev = Number(cur.dev ?? 0);
        if (curIno !== ino || curDev !== dev) {
          // Rotated/replaced: reopen and start at beginning of new file
          await fh.close().catch(() => {});
          fh = await fsp.open(logPath, "r");
          const cur2 = await fh.stat();
          ino = Number(cur2.ino ?? 0);
          dev = Number(cur2.dev ?? 0);
          offset = 0;
        }
      } catch {
        // File might briefly disappear during rotation
      }
      await drain();
    });

    // TODO(sam): do we need this?
    // const tick = setInterval(() => {
    //   drain().catch(() => {});
    // }, tickMs);

    return async function stop() {
      closed = true;
      watcher.close();
      // clearInterval(tick);
      await fh.close().catch(() => {});
      await persist();
    };
  }

  async function removeStateFiles() {
    await Promise.allSettled([fsp.rm(stateFile), fsp.rm(log)]);
  }

  async function killPid(pid: number, signal: "SIGTERM" | "SIGKILL") {
    try {
      process.kill(pid, signal);
    } catch {
      return true;
    }
    // For some reason, `isPidAlive` returns true even after the process exits.
    // However, `find-process` returns a process with name "<defunct>", so we can use that instead.
    // TODO: verify that this works on Windows
    const isActive = (await find("pid", pid)).some(
      (p) => p.name !== "<defunct>",
    );
    return !isActive;
  }

  // ------------------------ main flow ------------------------

  const pid = await ensureChildRunning();
  const stoppers: Array<() => Promise<void>> = [];

  if (!quiet) {
    const write = quiet
      ? () => false
      : (buf: Buffer) => process.stdout.write(buf);

    // Start followers (stdout/stderr) and mirror to this process
    const stopStdout = await followFilePersisted(outPath, {
      stateKey: `${path.resolve(outPath)}::stdout`,
      write,
    });
    stoppers.push(stopStdout);

    // Only follow stderr separately if it's a different file
    if (errPath !== outPath) {
      const stopStderr = await followFilePersisted(errPath, {
        stateKey: `${path.resolve(errPath)}::stderr`,
        write,
      });
      stoppers.push(stopStderr);
    }
  }

  // Return both extracted value and cleanup function
  return {
    extracted: await extracted,
    exit: async () => {
      await Promise.all(stoppers.map((stop) => stop()));
      if ((await killPid(pid, "SIGTERM")) || (await killPid(pid, "SIGKILL"))) {
        await removeStateFiles();
      }
    },
  };
}
