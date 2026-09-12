import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import {
  ChildProcessSpawner,
  make as makeSpawner,
} from "effect/unstable/process/ChildProcessSpawner";
import * as fs from "node:fs";

/**
 * Workaround for oven-sh/bun#32067 / #40907 on macOS.
 *
 * Darwin's `posix_spawn` cannot wire a file descriptor numbered >= OPEN_MAX
 * (10240) into a child, and Bun swallows that EBADF: the child starts with
 * closed stdio and every piped spawn reads back empty output with exit 0/1
 * and no error. `bun --watch` holds one kqueue fd per watched module, so a
 * dev stack whose import graph is ~10k files (anything importing
 * `alchemy/AWS`) pushes every pipe Bun creates past the limit, and `gh auth
 * token`, `git`, esbuild, ... all silently return nothing from the exec child.
 *
 * The workaround pins a block of LOW descriptors before the module graph
 * loads and frees them around each spawn, so the pipes land on the freed low
 * numbers. Between spawns the block is re-taken so later lazy imports cannot
 * eat the holes. Import this module before anything heavy and call
 * `reserveLowFds()` at the top of the process.
 *
 * No-op off macOS or outside Bun: only Darwin has OPEN_MAX, and only Bun's
 * watcher holds an fd per file.
 */
const RESERVE_SIZE = 512;

const enabled =
  process.platform === "darwin" && typeof globalThis.Bun !== "undefined";

let reserved: number[] = [];
let inFlight = 0;

export const reserveLowFds = (): void => {
  if (!enabled || reserved.length > 0) return;
  const fds: number[] = [];
  try {
    for (let i = 0; i < RESERVE_SIZE; i++)
      fds.push(fs.openSync("/dev/null", "r"));
  } catch {
    // fd limit hit: keep whatever we managed to pin.
  }
  reserved = fds;
};

const releaseLowFds = (): void => {
  for (const fd of reserved) {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  }
  reserved = [];
};

/**
 * Wraps a `ChildProcessSpawner` so the low-fd block is freed while a spawn is
 * in flight and re-pinned once every concurrent spawn has wired its pipes.
 */
export const withLowFdReserve = (
  spawner: ChildProcessSpawner["Service"],
): ChildProcessSpawner["Service"] =>
  enabled
    ? makeSpawner((command: ChildProcess.Command) =>
        Effect.sync(() => {
          if (inFlight++ === 0) releaseLowFds();
        }).pipe(
          Effect.andThen(spawner.spawn(command)),
          Effect.ensuring(
            Effect.sync(() => {
              if (--inFlight === 0) reserveLowFds();
            }),
          ),
        ),
      )
    : spawner;

/** Layer overriding the ambient `ChildProcessSpawner` with the guarded one. */
export const layer: Layer.Layer<
  ChildProcessSpawner,
  never,
  ChildProcessSpawner
> = Layer.effect(
  ChildProcessSpawner,
  Effect.map(ChildProcessSpawner, withLowFdReserve),
);
