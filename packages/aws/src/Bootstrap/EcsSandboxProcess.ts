import { runProcess } from "alchemy/Runtime/Bootstrap";
import type { ContainerPlatformLayers } from "alchemy/Runtime/ContainerProcess";
import { runSandboxAgent } from "alchemy/SandboxAgent";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

export const bootstrap = <E>(platform: ContainerPlatformLayers<E>): Promise<void> =>
  runProcess(
    "Sandbox",
    runSandboxAgent(process.argv.slice(2)).pipe(
      Effect.provide(
        platform.httpServer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              platform.services,
              FetchHttpClient.layer,
              SecureRandom.layerWebCrypto,
              Logger.layer([Logger.consolePretty()]),
            ),
          ),
        ),
      ),
      Effect.scoped,
    ),
  );
