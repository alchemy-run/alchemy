import { makeRemoteBinding } from "../remote-bindings/RemoteBindings.ts";

export const remote = (binding: string, appId: string) =>
  makeRemoteBinding(
    {
      name: binding,
      type: "flagship",
      appId,
    },
    (service) => ({
      name: binding,
      service,
    }),
  );

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as Plugin from "../Plugin.ts";
import type { BindingHook } from "../PluginContext.ts";
import * as Storage from "../globals/Storage.ts";
import type * as LoopbackPlugin from "../globals/Loopback.ts";
import * as Loopback from "./Loopback.ts";
import { loadInternalWorker } from "../internal/internal-worker.ts";
import { formatExtensionModule } from "../internal/internal-modules.ts";
import { ConfigError } from "../RuntimeError.shared.ts";
import { evaluateFlag, type FlagDefinition } from "./FlagshipOptions.shared.ts";

export class Flagship extends Plugin.Service<Flagship, { directory: string }>()(
  "cloudflare-runtime/plugin/Flagship",
) {}
export const FlagshipLive = Layer.effect(
  Flagship,
  Effect.gen(function* () {
    const storage = yield* Storage.Storage;
    const directory = "disk" in storage ? storage.disk?.path : undefined;
    if (!directory)
      return yield* new ConfigError({
        subtag: "Flagship",
        message: "Local Flagship requires disk storage",
      });
    const esModule = yield* formatExtensionModule({
      worker: () =>
        loadInternalWorker(
          "#cloudflare-runtime-core-worker/bindings/Flagship.worker",
        ),
    });
    return Flagship.of({
      api: { directory: path.join(directory, "flagship") },
      extensions: [
        {
          modules: [
            { name: "cloudflare-runtime:flagship", internal: true, esModule },
          ],
        },
      ],
    });
  }),
);

/**
 * Offline native binding reading persisted local App/Flag definitions on each
 * evaluation. Local updates are immediate. Percentage buckets are stable locally
 * but are not guaranteed to match Cloudflare's unpublished hash algorithm.
 */
export const local = (
  binding: string,
  appId: string,
): BindingHook<Flagship | LoopbackPlugin.Loopback> =>
  Plugin.use(Flagship, (plugin) =>
    Effect.gen(function* () {
      const fetcher = yield* Loopback.local({
        binding: "FETCHER",
        name: `flagship:${appId}`,
        handler: async (request, response) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const input = JSON.parse(Buffer.concat(chunks).toString());
            let flag: FlagDefinition | undefined;
            try {
              flag = JSON.parse(
                await fs.readFile(
                  path.join(
                    plugin.api.directory,
                    encodeURIComponent(appId),
                    "flags",
                    `${encodeURIComponent(input.flagKey)}.json`,
                  ),
                  "utf8",
                ),
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            response
              .writeHead(200, { "content-type": "application/json" })
              .end(
                JSON.stringify(
                  evaluateFlag(
                    flag,
                    input.flagKey,
                    input.defaultValue,
                    input.type,
                    input.context,
                  ),
                ),
              );
          } catch (error) {
            response.writeHead(500).end(String(error));
          }
        },
      });
      return {
        name: binding,
        wrapped: {
          moduleName: "cloudflare-runtime:flagship",
          innerBindings: [fetcher],
        },
      };
    }),
  );

/** Shared offline evaluator for local control-plane Actions. */
export { evaluateFlag } from "./FlagshipOptions.shared.ts";
