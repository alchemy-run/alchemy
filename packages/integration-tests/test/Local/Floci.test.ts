import { ensureFloci } from "@alchemy.run/aws/Local/Floci";
import { expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

for (const mode of ["config", "environment"] as const) {
  it.live(
    `external Floci fails without Docker fallback (${mode})`,
    () =>
      Effect.gen(function* () {
        // An empty PATH hides `docker` from the spawn.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = process.env.PATH;
            process.env.PATH = "";
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              if (previous === undefined) delete process.env.PATH;
              else process.env.PATH = previous;
            }),
        );
        // Port zero cannot be a reachable gateway; Docker is also unavailable.
        const error = yield* ensureFloci({
          // Omitted in environment mode: an explicit value overrides the env var.
          external: mode === "config" ? true : undefined,
          port: 0,
          elbListenerPorts: [],
          cloudfrontEdgePorts: [],
        }).pipe(
          Effect.flip,
          // Config reads a snapshot of the environment, so set the variable
          // through the provider rather than on `process.env`.
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnvRecord(
              mode === "environment" ? { ALCHEMY_FLOCI_EXTERNAL: "1" } : {},
            ),
          ),
        );
        expect(error._tag).toBe("FlociError");
        expect(error.message).toBe("external floci server unavailable at http://localhost:0");
      }),
    { exclusive: true, timeout: 15_000, tags: ["unit", "provider:aws", "local"] },
  );
}
