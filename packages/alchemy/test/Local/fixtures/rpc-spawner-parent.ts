// Test fixture: boots an RpcSpawner, POSTs once with the child entry given by
// the first CLI arg, and prints `PARENT_PID=<n>` and `CHILD_PID=<n>` lines to
// stdout so the test harness can observe them. Then idles until killed.
// Relative imports (not `@/` alias) so this file runs under both Bun and
// Node without a paths-aware loader. This fixture is excluded from the test
// project's typecheck (see tsconfig.test.json) because the relative path
// crosses composite-project boundaries.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { layerServer, RpcSpawner } from "../../../src/Local/RpcSpawner.ts";
import { PlatformServices } from "../../../src/Util/PlatformServices.ts";

const childEntry = process.argv[2];
if (!childEntry) {
  console.error("usage: rpc-spawner-parent.ts <child-entry-url>");
  process.exit(2);
}

const program = Effect.gen(function* () {
  const sp = yield* RpcSpawner;
  const res = yield* Effect.promise(() =>
    fetch(sp.url, {
      method: "POST",
      body: JSON.stringify({
        serverEntryUrl: childEntry,
        alchemyContext: {
          dotAlchemy: "/tmp/.alchemy",
          updateStateStore: false,
          dev: true,
          adopt: false,
        },
        stack: { name: "test", stage: "dev" },
      }),
      headers: { "content-type": "application/json" },
    }).then((r) => r.text()),
  );

  // The child's pid is whatever owns the listening port returned in res.
  // We surface it for the test harness via stdout.
  process.stdout.write(`PARENT_PID=${process.pid}\n`);
  process.stdout.write(`CHILD_URL=${res}\n`);

  const stop = yield* Deferred.make<void>();
  yield* Deferred.await(stop);
});

Effect.runPromise(
  program.pipe(
    Effect.provide(
      Layer.provide(
        layerServer({ profile: undefined, envFile: undefined }),
        PlatformServices,
      ),
    ),
    Effect.scoped,
  ),
).catch((e) => {
  console.error(e);
  process.exit(1);
});
