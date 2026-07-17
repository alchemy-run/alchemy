import * as Effect from "effect/Effect";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// API Gateway REST has a very low account-wide control-plane mutation quota,
// especially for deleting REST APIs. The authoritative AWS sweep runs a
// distributed lane and a Lambda-quota lane in separate Bun processes; an
// in-memory semaphore cannot coordinate a RestApiEventSource test in one lane
// with ordinary ApiGateway tests in the other. Use one service-local,
// cross-process lock directory instead. Unrelated AWS services remain fully
// parallel.
const profile = (process.env.ALCHEMY_PROFILE ?? "testing").replace(
  /[^a-zA-Z0-9_.-]/g,
  "-",
);
const uid = process.getuid?.() ?? 0;
const lockDirectory = join(
  tmpdir(),
  `alchemy-test-apigateway-${uid}-${profile}.lock`,
);
const ownerFile = join(lockDirectory, "owner");

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const wait = (millis: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, millis));

export const makeApiGatewayTestLease = () => {
  let held = false;

  return {
    acquire: Effect.tryPromise({
      try: async (signal) => {
        while (!signal.aborted) {
          try {
            await mkdir(lockDirectory);
            await writeFile(ownerFile, String(process.pid), "utf8");
            held = true;
            return;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
              throw error;
            }

            // Reclaim a lock left by a hard-killed test process. A missing or
            // partially-written owner file is treated as live briefly; the
            // current owner writes it immediately after the atomic mkdir.
            let ownerPid: number | undefined;
            try {
              ownerPid = Number.parseInt(await readFile(ownerFile, "utf8"), 10);
            } catch {
              await wait(250);
              continue;
            }
            if (
              ownerPid !== undefined &&
              Number.isFinite(ownerPid) &&
              processIsAlive(ownerPid)
            ) {
              await wait(250);
              continue;
            }
            await rm(lockDirectory, { recursive: true, force: true });
          }
        }
        throw new Error("ApiGateway test lease acquisition was interrupted");
      },
      catch: (error) =>
        error instanceof Error ? error : new Error(String(error)),
    }),
    release: Effect.suspend(() => {
      if (!held) return Effect.void;
      held = false;
      return Effect.tryPromise({
        try: () => rm(lockDirectory, { recursive: true, force: true }),
        catch: (error) =>
          error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.orDie, Effect.asVoid);
    }),
  };
};
