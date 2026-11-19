import { runtimeConfigProvider } from "alchemy/Runtime";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import cloudflare_workers from "./cloudflare_workers.ts";

/**
 * A `ConfigProvider` backed by the running Worker's environment: the same
 * provider the Worker bridge installs by default (see `runtimeConfigProvider`).
 */
export const WorkerConfigProvider = () =>
  cloudflare_workers.pipe(
    Effect.map(({ env }) =>
      runtimeConfigProvider(ConfigProvider.fromUnknown(env, { preserveEmptyStrings: true })),
    ),
  );
