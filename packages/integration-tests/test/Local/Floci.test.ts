import { ensureFloci } from "@alchemy.run/aws/Local/Floci";
import { expect, it } from "@alchemy.run/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

for (const mode of ["config", "environment"] as const) {
  it.live(
    `external Floci fails without Docker fallback (${mode})`,
    () =>
      Effect.gen(function* () {
        // Docker is unavailable: a fallback to it would fail differently.
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
        // `ensureFloci` reads ALCHEMY_FLOCI_EXTERNAL through Config, so the
        // environment is the ConfigProvider's, not a process.env write.
        const environment = ConfigProvider.fromUnknown(
          mode === "environment" ? { ALCHEMY_FLOCI_EXTERNAL: "1" } : {},
        );
        // Port zero cannot be a reachable gateway; Docker is also unavailable.
        const error = yield* ensureFloci({
          // Omitted in environment mode: an explicit value overrides the env var.
          external: mode === "config" ? true : undefined,
          port: 0,
          elbListenerPorts: [],
          cloudfrontEdgePorts: [],
        }).pipe(Effect.flip, Effect.provideService(ConfigProvider.ConfigProvider, environment));
        expect(error._tag).toBe("FlociError");
        expect(error.message).toBe("external floci server unavailable at http://localhost:0");
      }),
    { exclusive: true, timeout: 15_000, tags: ["unit", "provider:aws", "local"] },
  );
}
