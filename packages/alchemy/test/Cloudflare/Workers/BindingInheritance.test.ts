import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as pathe from "pathe";
import { expectUrlContains } from "../Utils/Http.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider(
  "strict binding inheritance preserves a deployed secret",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const deploy = (mode: "seed" | "inherit" | "keep") =>
        stack.deploy(
          Effect.gen(function* () {
            const worker = yield* Cloudflare.Worker("InheritedBinding", {
              main: pathe.resolve(
                import.meta.dirname,
                "fixtures/binding-inherit-worker.ts",
              ),
              bindingsInherit: mode === "inherit" ? "strict" : undefined,
              keepBindings: mode === "keep" ? ["secret_text"] : undefined,
            });
            if (mode !== "keep")
              yield* worker.bind`value`({
                bindings: [
                  mode === "inherit"
                    ? { type: "inherit", name: "VALUE" }
                    : {
                        type: "secret_text",
                        name: "VALUE",
                        text: "fixture-inherited-value",
                      },
                ],
              });
            return worker;
          }),
        );
      const initial = yield* deploy("seed");
      yield* expectUrlContains(initial.url!, "fixture-inherited-value", {
        timeout: "30 seconds",
      });
      const inherited = yield* deploy("inherit");
      expect(inherited.workerName).toBe(initial.workerName);
      yield* expectUrlContains(inherited.url!, "fixture-inherited-value", {
        timeout: "30 seconds",
      });
      const kept = yield* deploy("keep");
      expect(kept.workerName).toBe(initial.workerName);
      yield* expectUrlContains(kept.url!, "fixture-inherited-value", {
        timeout: "30 seconds",
      });
      yield* stack.destroy();
    }),
  { timeout: 90000 },
);
