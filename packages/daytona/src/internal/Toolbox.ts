import { Credentials } from "@distilled.cloud/daytona/Credentials";
import * as Effect from "effect/Effect";

/**
 * Point toolbox operations (process, files, git, LSP, computer use, …) at
 * one sandbox. Daytona addresses the toolbox by sandbox in the base URL,
 * not in the request, so the sandbox is client configuration: this
 * re-provides `Credentials` with `sandboxId` (and the sandbox's own proxy
 * URL when known) on top of the ambient credentials.
 */
export const inSandbox =
  (sandboxId: string, toolboxProxyUrl?: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Credentials> =>
    Effect.gen(function* () {
      const base = yield* Credentials;
      return yield* Effect.provideService(
        effect,
        Credentials,
        Effect.map(base, (config) => ({
          ...config,
          sandboxId,
          toolboxBaseUrl: toolboxProxyUrl
            ? `${toolboxProxyUrl.replace(/\/$/, "")}/${sandboxId}`
            : config.toolboxBaseUrl,
        })),
      );
    });
