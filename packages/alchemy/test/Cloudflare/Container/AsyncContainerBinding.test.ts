/**
 * Binding collection for a Container bound on an async Worker's `env`.
 *
 * Compile-only (no cloud): binding rows are collapsed by `sid` — last write
 * wins — so two `bind` calls whose sids can coincide silently drop one of
 * them. `bindContainerClass` contributes the `durable_object_namespace`
 * binding and the `containers` script metadata for the SAME env entry, so
 * they must share one sid. When they didn't, an env key equal to the
 * Container's logical id (`Sandbox: Container("Sandbox", …)`) lost the
 * namespace binding, and the Worker uploaded the Container declaration itself
 * as a `json` binding (`{"_id":"Effect","op":"alchemy/EffectClass"}`) —
 * `getSandbox(env.Sandbox, id)` then dies with `t.idFromName is not a
 * function` at runtime.
 */
import * as Cloudflare from "@/Cloudflare/index.ts";
import { dedupeBindings } from "@/Diff.ts";
import * as Stack from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

const { test } = Test.make({
  providers: Layer.empty,
  state: inMemoryState(),
});

/**
 * Compile the stack and return the binding rows the Worker provider would
 * observe for `fqn` — i.e. sid-collapsed, exactly as `diffBindings` hands
 * them to `reconcile`.
 */
const workerBindings = (
  effect: Effect.Effect<unknown, never, any>,
  fqn: string,
) =>
  effect.pipe(
    Stack.make({
      name: "test",
      providers: Layer.empty,
      state: inMemoryState(),
    }),
    Effect.provideService(Stage, "test"),
    Effect.map((stack: Stack.CompiledStack) =>
      dedupeBindings(stack.bindings[fqn] ?? []),
    ),
  );

const stack = (bindingName: string, containerId: string) =>
  Effect.gen(function* () {
    yield* Cloudflare.Worker("Provision", {
      main: "./worker.ts",
      env: {
        [bindingName]: Cloudflare.Container(containerId, {
          className: "Sandbox",
          image: "mendhak/http-https-echo:latest",
        }),
      },
    });
  });

describe("Container bound on an async Worker's env", () => {
  for (const [name, containerId] of [
    ["binding name differs from the container id", "SandboxContainer"],
    // The collision: `bind` sids are collapsed last-write-wins, so the
    // `containers` row keyed on the application's logical id used to clobber
    // the namespace binding keyed on the env key.
    ["binding name equals the container id", "Sandbox"],
  ] as const) {
    test(
      `emits the durable object namespace binding when the ${name}`,
      Effect.gen(function* () {
        const bindings = yield* workerBindings(
          stack("Sandbox", containerId),
          "Provision",
        );

        expect(bindings.flatMap((b) => b.data.bindings ?? [])).toEqual([
          {
            type: "durable_object_namespace",
            name: "Sandbox",
            className: "Sandbox",
          },
        ]);
        // The script metadata that marks the class container-backed must
        // survive alongside it.
        expect(
          bindings.flatMap((b) =>
            (b.data.containers ?? []).map(
              (c: { className: string }) => c.className,
            ),
          ),
        ).toEqual(["Sandbox"]);
      }),
    );
  }
});
