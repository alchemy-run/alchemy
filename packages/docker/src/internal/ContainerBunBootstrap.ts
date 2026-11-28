import { Self } from "alchemy/Self";

// These templates preserve the generated entries of existing Kubernetes Bun
// workloads. Keep their output byte-for-byte stable until a one-time rollout
// is acceptable and Bun can move to ContainerProcess.
export const makeServerBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { BunHttpServer } from "alchemy/Http";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { makeEntrypointLayer, RuntimeConfigProviderLive } from "alchemy/Runtime";
import { provideProcessTelemetry } from "alchemy/Telemetry";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

// Normalize the entrypoint export: an inline-effect class default export is
// an Effect resolving the platform instance, while the tagged form
// (X.make(props, impl)) exports a Layer providing the Self tag. Both fold
// into a Layer via makeEntrypointLayer (same pattern as the ECS/Lambda/
// Cloudflare Container bridges).
const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  SecureRandom.layerWebCrypto,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program (the runners registered via host.run / serve)
// and run it with a Bun HTTP server bound to PORT, so a returned { fetch }
// handler is served and host.run loops stay alive.
const program = tag.pipe(
  // Process-lifetime telemetry: built once into the root scope; exporters
  // batch on their intervals and flush when the scope closes on graceful
  // shutdown.
  Effect.flatMap((host) =>
    host.RuntimeContext.exports.pipe(
      Effect.flatMap((exports) => exports.program),
      provideProcessTelemetry(host.RuntimeContext),
    ),
  ),
  Effect.provide(
    layer.pipe(Layer.provideMerge(Layer.mergeAll(
      Layer.effect(
        Stack,
        Effect.all([
          Config.String("ALCHEMY_STACK_NAME"),
          Config.String("ALCHEMY_STAGE")
        ]).pipe(
          Effect.map(([name, stage]) => ({
            name,
            stage,
            bindings: {},
            resources: {}
          }))
        )
      ),
      // Module-scope declarations shared with the Stack may read the stage.
      Layer.effect(Stage, Config.String("ALCHEMY_STAGE")),
    )),
      Layer.provideMerge(BunHttpServer()),
      Layer.provideMerge(platform),
      Layer.provideMerge(RuntimeConfigProviderLive),
    )
  ),
  Effect.scoped
);

console.log(\`Kubernetes Deployment bootstrap starting on port \${process.env.PORT ?? 3000}...\`);
await Effect.runPromise(program).catch((err) => {
  console.error("Kubernetes Deployment bootstrap failed:", err);
  process.exit(1);
});
`;

export const makeJobBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { BunServices } from "@effect/platform-bun";
import { Stack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import { makeEntrypointLayer, RuntimeConfigProviderLive } from "alchemy/Runtime";
import { provideProcessTelemetry } from "alchemy/Telemetry";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";

import { ${handler} as entrypoint } from ${JSON.stringify(importPath)};

// Normalize the entrypoint export (see the server bootstrap).
const tag = Context.Service("${Self.key}");
const layer = makeEntrypointLayer(tag, entrypoint);

const platform = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  SecureRandom.layerWebCrypto,
  Logger.layer([Logger.consolePretty()]),
);

// Resolve the bundled program's registered one-shot runners (the shape's
// \`run\` effect and any host.run work) and execute them to completion.
const program = tag.pipe(
  // Process-lifetime telemetry: built once into the root scope; exporters
  // batch on their intervals and flush when the scope closes as the
  // one-shot program completes.
  Effect.flatMap((host) =>
    host.RuntimeContext.exports.pipe(
      Effect.flatMap((exports) => exports.program),
      provideProcessTelemetry(host.RuntimeContext),
    ),
  ),
  Effect.provide(
    layer.pipe(Layer.provideMerge(Layer.mergeAll(
      Layer.effect(
        Stack,
        Effect.all([
          Config.String("ALCHEMY_STACK_NAME"),
          Config.String("ALCHEMY_STAGE")
        ]).pipe(
          Effect.map(([name, stage]) => ({
            name,
            stage,
            bindings: {},
            resources: {}
          }))
        )
      ),
      // Module-scope declarations shared with the Stack may read the stage.
      Layer.effect(Stage, Config.String("ALCHEMY_STAGE")),
    )),
      Layer.provideMerge(platform),
      Layer.provideMerge(RuntimeConfigProviderLive),
    )
  ),
  Effect.scoped
);

console.log("Kubernetes Job bootstrap starting...");
await Effect.runPromise(program).catch((err) => {
  console.error("Kubernetes Job bootstrap failed:", err);
  process.exit(1);
});
// Run-to-completion semantics: exit 0 explicitly so lingering handles
// (sockets, timers) never keep the pod alive after the work is done.
process.exit(0);
`;
