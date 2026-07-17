import * as Effect from "effect/Effect";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AWS permits only one OAM sink per account and Region. Files still run in
// parallel globally, but the distributed and Lambda quota lanes are separate
// Bun processes. Hold a service-local cross-process lease for each file's full
// setup/assert/teardown lifecycle so Sink.test and Bindings.test cannot delete,
// replace, or throttle each other's singleton sink.
const profile = (process.env.ALCHEMY_PROFILE ?? "testing").replace(
  /[^a-zA-Z0-9_.-]/g,
  "-",
);
const uid = process.getuid?.() ?? 0;
const lockDirectory = join(tmpdir(), `alchemy-test-oam-${uid}-${profile}.lock`);
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

export const makeOamTestLease = () => {
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
        throw new Error("OAM test lease acquisition was interrupted");
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
