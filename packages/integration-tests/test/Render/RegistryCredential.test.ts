import * as Render from "@alchemy.run/render";
import { describe, expect } from "@alchemy.run/test";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expectAllNoop, makeRenderTest } from "./common.ts";

const t = makeRenderTest();

describe(
  "Render.RegistryCredential",
  { tags: ["provider:render", "live"], timeout: 120_000 },
  () => {
    t.test.provider(
      "creates, plans noop, looks up, lists, updates, and destroys a RegistryCredential",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();

          const prov = yield* Provider.findProvider(Render.RegistryCredential);
          const program = (version: "v1" | "v2") =>
            Effect.gen(function* () {
              const cred = yield* Render.RegistryCredential("Cred", {
                registry: "DOCKER",
                username: `alchemy-live-${version}`,
                authToken: Redacted.make(`dckr_pat_live_${version}`),
              });
              return { cred };
            });

          const created = yield* stack.deploy(program("v1"));
          expect(created.cred.id).toMatch(/^rgc-/);
          expect(created.cred.registry).toBe("DOCKER");

          yield* expectAllNoop(stack, program("v1"));

          const found = yield* prov.lookup!({ name: created.cred.name });
          expect(found?.id).toBe(created.cred.id);
          expect((yield* prov.list!()).some((c) => c.id === created.cred.id)).toBe(true);

          const updated = yield* stack.deploy(program("v2"));
          expect(updated.cred.id).toBe(created.cred.id);

          yield* stack.destroy();
          expect(yield* prov.lookup!({ id: created.cred.id })).toBeUndefined();
        }),
      { tags: ["provider:render", "live"], timeout: 120_000 },
    );
  },
);
