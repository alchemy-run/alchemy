import { WorkerBundle } from "@/Cloudflare/Workers/Sources/Rolldown.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

layer(NodeServices.layer)("Forgejo runtime boundary", (test) => {
  test.effect(
    "excludes deployment profile, token minting and CLI code from the Worker bundle",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const bundler = yield* WorkerBundle;
        const output = yield* bundler.build({
          id: "ForgejoRuntimeBoundary",
          main: path.resolve("test/Forgejo/fixtures/worker.ts"),
          compatibility: { date: "2026-03-17", flags: ["nodejs_compat"] },
          entry: { kind: "effect", exports: {} },
          stack: { name: "ForgejoRuntimeBoundary", stage: "test" },
          extraOptions: undefined,
        });
        const code = yield* Effect.sync(() =>
          output.files
            .filter((file) => file.path.endsWith(".js"))
            .map((file) =>
              typeof file.content === "string"
                ? file.content
                : new TextDecoder().decode(file.content),
            )
            .join("\n"),
        );
        for (const forbidden of [
          "Alchemy::ProfileStore",
          "loadProviderConfig",
          "Automatic Forgejo token provisioning requires",
          "@effect/platform-bun",
          "adminCreateUserAccessToken",
          "alchemy profile edit",
        ]) {
          expect({ forbidden, included: code.includes(forbidden) }).toEqual({
            forbidden,
            included: false,
          });
        }
      }),
    { timeout: 120_000 },
  );
});
