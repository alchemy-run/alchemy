import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { make } from "@/Test/Vitest.ts";

const seen: Array<string> = [];

const { afterAll, test } = make({ providers: Layer.empty });

afterAll(
  Effect.sync(() => {
    seen.push("first");
  }),
);

// The shared scope must still be open here. Vitest's default `afterAll`
// order is reverse registration, which used to close that scope before
// this hook.
afterAll(
  Effect.gen(function* () {
    let finished = false;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (!finished) {
          throw new Error("shared scope closed before afterAll finished");
        }
      }),
    );
    if (seen.join(",") !== "first") {
      throw new Error(`earlier afterAll did not run first: ${seen.join(",")}`);
    }
    seen.push("second");
    finished = true;
  }),
);

test(
  "afterAll hooks run before the shared scope closes",
  Effect.sync(() => undefined),
);
