// Fixture: construct CliKit.layer under whatever runtime spawned us.
// Relative imports (not `@/` alias) so Node can load this without a
// paths-aware resolver. Excluded from tsconfig.test.json for the same
// composite-project reason as the Dev RPC fixtures.
import * as Effect from "effect/Effect";
import { CliKit, layer } from "../../../src/Cli/CliKit/index.ts";

Effect.gen(function* () {
  const cli = yield* CliKit;
  yield* cli.output.info("ok");
  yield* Effect.sync(() => {
    process.stdout.write("CLIKIT_READY\n");
  });
})
  .pipe(Effect.provide(layer({ input: false })), Effect.scoped)
  .pipe(Effect.runPromise)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
