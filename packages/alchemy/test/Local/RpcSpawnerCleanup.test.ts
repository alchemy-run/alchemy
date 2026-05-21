import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  spawn,
  spawnSync,
  type ChildProcess as NodeChildProcess,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimes } from "./fixtures/runtimes.ts";

const PARENT_TS = fileURLToPath(
  new URL("./fixtures/rpc-spawner-parent.ts", import.meta.url),
);
const CHILD_TS_URL = new URL(
  "./fixtures/rpc-server-entry.ts",
  import.meta.url,
).toString();

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidOf = (wsUrl: string): number | undefined => {
  const port = new URL(wsUrl).port;
  const r = spawnSync("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-t"], {
    encoding: "utf-8",
  });
  if (r.status !== 0) return undefined;
  const pid = Number.parseInt(r.stdout.trim().split("\n")[0]!, 10);
  return Number.isFinite(pid) ? pid : undefined;
};

const waitUntil = async (
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
};

interface ParentHandle {
  readonly proc: NodeChildProcess;
  readonly parentPid: number;
  readonly childPid: number;
}

const startParent = (argv: Array<string>): Promise<ParentHandle> =>
  new Promise<ParentHandle>((resolve, reject) => {
    const proc = spawn(argv[0]!, argv.slice(1), {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const t = setTimeout(
      () =>
        reject(
          new Error(
            `parent never reported CHILD_URL. stdout=${stdout} stderr=${stderr}`,
          ),
        ),
      30_000,
    );
    proc.stdout!.on("data", (d) => {
      stdout += d.toString();
      const childUrlMatch = stdout.match(/CHILD_URL=(\S+)/);
      const parentPidMatch = stdout.match(/PARENT_PID=(\d+)/);
      if (childUrlMatch && parentPidMatch) {
        const childPid = pidOf(childUrlMatch[1]!);
        if (childPid !== undefined) {
          clearTimeout(t);
          resolve({
            proc,
            parentPid: Number.parseInt(parentPidMatch[1]!, 10),
            childPid,
          });
        }
      }
    });
    proc.stderr!.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("exit", () => {
      clearTimeout(t);
      reject(
        new Error(
          `parent exited before reporting CHILD_URL. stdout=${stdout} stderr=${stderr}`,
        ),
      );
    });
  });

for (const runtime of runtimes()) {
  describe.skipIf(!runtime.available)(
    `Local.RpcSpawner cleanup (${runtime.name})`,
    () => {
      const cleanups: Array<() => void> = [];

      afterEach(() => {
        for (const c of cleanups.splice(0)) c();
      });

      const launch = async () => {
        const argv = runtime.argv(PARENT_TS).concat([CHILD_TS_URL]);
        const handle = await startParent(argv);
        cleanups.push(() => {
          try {
            handle.proc.kill("SIGKILL");
          } catch {}
          if (isAlive(handle.childPid)) {
            try {
              process.kill(handle.childPid, "SIGKILL");
            } catch {}
          }
        });
        return handle;
      };

      it("child dies after parent receives SIGTERM", async () => {
        const { proc, parentPid, childPid } = await launch();
        expect(isAlive(childPid)).toBe(true);
        process.kill(parentPid, "SIGTERM");
        const parentExited = await waitUntil(
          () => proc.exitCode !== null,
          10_000,
        );
        expect(parentExited).toBe(true);
        const childDead = await waitUntil(() => !isAlive(childPid), 5_000);
        expect(childDead).toBe(true);
      }, 45_000);

      it("child dies after parent receives SIGKILL", async () => {
        const { proc, parentPid, childPid } = await launch();
        expect(isAlive(childPid)).toBe(true);
        process.kill(parentPid, "SIGKILL");
        const parentExited = await waitUntil(
          () => proc.exitCode !== null || proc.signalCode !== null,
          10_000,
        );
        expect(parentExited).toBe(true);
        const childDead = await waitUntil(() => !isAlive(childPid), 5_000);
        expect(childDead).toBe(true);
      }, 45_000);
    },
  );
}
