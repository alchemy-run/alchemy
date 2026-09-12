import { reserveLowFds } from "alchemy/Dev/LowFdReserve";

// Pin low fds BEFORE the CLI's module graph loads under `bun --watch` (see
// LowFdReserve.ts); the heavy imports are dynamic so this runs first.
reserveLowFds();

const [{ exec }, { runMain }] = await Promise.all([
  import("alchemy/Cli"),
  import("alchemy/Util/PlatformServices"),
]);

exec().pipe(runMain);
