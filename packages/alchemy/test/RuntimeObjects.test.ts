import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Provider from "@/Provider";
import { Resource } from "@/Resource";
import * as RuntimeObjects from "@/RuntimeObjects";
import { inMemoryState } from "@/State";

type Kind = "sandbox" | "volume";

type Objects = Resource<
  "Test.RuntimeObjects",
  RuntimeObjects.RuntimeObjectsProps<Kind>,
  RuntimeObjects.RuntimeObjectsAttributes<Kind>
>;
const Objects = Resource<Objects>("Test.RuntimeObjects");

const swept: Array<RuntimeObjects.RuntimeObjectsAttributes<Kind>> = [];

// A provider's RuntimeObjects resource is exactly this: the shared lifecycle
// around the platform's own sweep.
const ObjectsProvider = () =>
  Provider.effect(
    Objects,
    Effect.succeed(
      RuntimeObjects.lifecycle((attrs: RuntimeObjects.RuntimeObjectsAttributes<Kind>) =>
        Effect.sync(() => {
          swept.push(attrs);
        }),
      ),
    ),
  );

const { test } = Test.make({
  providers: Layer.mergeAll(ObjectsProvider()),
  state: inMemoryState(),
});

describe("alchemy/RuntimeObjects", { tags: ["unit", "local"] }, () => {
  test.provider("stamps once, keeps the stamp, and sweeps on destroy", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      swept.length = 0;

      const first = yield* stack.deploy(Objects("Sandboxes", { kinds: ["sandbox"] }));
      expect(first.tags).toMatchObject({ "alchemy::id": "Sandboxes" });
      expect(first.owner).toBe(Object.values(first.tags).join("/"));
      expect(first.prefix).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(
        RuntimeObjects.isRuntimeName(first.prefix, RuntimeObjects.runtimeName(first.prefix, "u1")),
      ).toBe(true);

      const second = yield* stack.deploy(Objects("Sandboxes", { kinds: ["sandbox", "volume"] }));
      expect(second.prefix).toBe(first.prefix);
      expect(second.kinds).toEqual(["sandbox", "volume"]);

      yield* stack.destroy();
      expect(swept).toEqual([second]);
    }),
  );

  test.provider("retain skips the sweep", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      swept.length = 0;
      yield* stack.deploy(Objects("Kept", { kinds: ["volume"], onDestroy: "retain" }));
      yield* stack.destroy();
      expect(swept).toEqual([]);
    }),
  );
});
