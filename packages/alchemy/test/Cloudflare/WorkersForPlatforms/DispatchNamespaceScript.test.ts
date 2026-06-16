import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A dispatch namespace script is keyed by (namespace, scriptName) and the
// Cloudflare API exposes no enumeration op for scripts within a namespace
// (only get/put/delete by exact scriptName). It is therefore non-listable
// (pattern (e)) — `list()` returns `[]` and never touches the API, so this
// assertion needs no Workers-for-Platforms entitlement and no deploy.
test.provider(
  "list returns [] for the non-listable namespace script",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(
        Cloudflare.DispatchNamespaceScript,
      );
      const all = yield* provider.list();
      expect(all).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
