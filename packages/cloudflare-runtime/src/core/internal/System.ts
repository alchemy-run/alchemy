import * as NodeOs from "node:os";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const home = Config.String("CLOUDFLARE_RUNTIME_HOME").pipe(
  Effect.orElseSucceed(() => NodeOs.homedir()),
);

export const fileSystemSupportsWatcher = Config.Boolean(
  "CLOUDFLARE_RUNTIME_FILE_SYSTEM_SUPPORTS_WATCHER",
).pipe(Effect.orElseSucceed(() => NodeOs.platform() !== "win32"));

/**
 * How often a registry entry's owner refreshes it, so readers don't reap it
 * as stale. Overridable for tests.
 */
export const registryHeartbeat = Config.Duration("CLOUDFLARE_RUNTIME_REGISTRY_HEARTBEAT").pipe(
  Effect.orElseSucceed(() => Duration.seconds(30)),
);
