import { bindWorkerAsyncBindings } from "@/Cloudflare/Workers/WorkerAsyncBindings.ts";
import type { Worker } from "@/Cloudflare/Workers/Worker.ts";
import type { WorkerBinding } from "@/Cloudflare/Workers/WorkerBinding.ts";
import { resolveSecretManager, SecretManagerContext } from "@/SecretManager.ts";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { externalIntegration } from "../../fixtures/external-secret-manager.ts";

it.effect(
  "spreads adapter bindings as secrets, plaintext and JSON without tooling credentials",
  () =>
    Effect.gen(function* () {
      const integration = externalIntegration();
      const resolved = yield* resolveSecretManager({
        secrets: integration.layer,
        stack: "app",
        stage: "preview",
        fallback: ConfigProvider.fromUnknown({}),
      });
      const captured: WorkerBinding[] = [];
      // Capture the actual binding hook's output without provisioning a Worker.
      const worker = {
        Mode: "remote",
        bind: () => (data: { bindings: WorkerBinding[] }) =>
          Effect.sync(() => {
            captured.push(...data.bindings);
          }),
      } as unknown as Worker;
      yield* Effect.gen(function* () {
        const bindings = yield* integration.bindings;
        // Only value bindings are supplied. The hook's resource-provider
        // requirements belong to its resource branches, which this test
        // intentionally leaves unprovided so any unexpected use fails.
        yield* bindWorkerAsyncBindings(worker, {
          env: { ...bindings, EXTRA: "literal" },
        }) as Effect.Effect<void>;
      }).pipe(
        Effect.provideService(SecretManagerContext, resolved),
        Effect.provideService(ConfigProvider.ConfigProvider, resolved.provider),
      );
      expect(captured).toEqual([
        { name: "API_KEY", type: "secret_text", text: "secret-preview" },
        {
          name: "PUBLIC_URL",
          type: "plain_text",
          text: "https://preview.example.com",
        },
        { name: "FEATURE_ENABLED", type: "json", json: true },
        {
          name: "__INTEGRATION_ENV",
          type: "secret_text",
          text: "runtime-preview",
        },
        { name: "EXTRA", type: "plain_text", text: "literal" },
      ]);
    }),
);
