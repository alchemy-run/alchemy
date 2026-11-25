import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Provider from "@/Provider.ts";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import { Resource } from "@/Resource.ts";
import { inMemoryState } from "@/State/index.ts";

interface Guarded extends Resource<"Test.Guarded", { revision: number }, { revision: number }> {}
const Guarded = Resource<Guarded>("Test.Guarded");

const seen: Array<{ phase: "diff" | "reconcile"; protected: boolean | undefined }> = [];
let failUnprotect = false;
let failCreate = false;
const { test } = Test.make({
  state: inMemoryState(),
  providers: Provider.succeed(Guarded, {
    list: () => Effect.succeed([]),
    diff: ({ protected: protectedFromDeletion }) =>
      Effect.sync(() => {
        seen.push({ phase: "diff", protected: protectedFromDeletion });
        return { action: "update" as const };
      }),
    reconcile: ({ news, olds, protected: protectedFromDeletion }) =>
      Effect.gen(function* () {
        seen.push({ phase: "reconcile", protected: protectedFromDeletion });
        if (failCreate && olds === undefined) {
          return yield* Effect.fail({
            _tag: "InjectedCreateFailure",
            message: "injected failed create",
          });
        }
        if (failUnprotect && news.revision === 2) {
          return yield* Effect.fail({
            _tag: "InjectedUnprotectFailure",
            message: "injected failed unprotect update",
          });
        }
        return { revision: news.revision };
      }),
    delete: () => Effect.void,
  }),
});

test.provider(
  "effective provider protection includes declared, stored, and interrupted policies",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      seen.length = 0;
      failUnprotect = false;

      yield* stack.deploy(Guarded("Guard", { revision: 1 }).pipe(RemovalPolicy.protect()));
      expect(seen.at(-1)).toEqual({ phase: "reconcile", protected: true });

      seen.length = 0;
      // The desired declaration is already unprotected. The previous
      // successful policy still applies during this whole update.
      yield* stack.deploy(Guarded("Guard", { revision: 2 }));
      expect(seen).toEqual([
        { phase: "diff", protected: true },
        { phase: "reconcile", protected: true },
      ]);

      seen.length = 0;
      yield* stack.deploy(Guarded("Guard", { revision: 3 }));
      expect(seen).toEqual([
        { phase: "diff", protected: false },
        { phase: "reconcile", protected: false },
      ]);

      yield* stack.destroy();
      yield* stack.deploy(Guarded("Guard", { revision: 1 }).pipe(RemovalPolicy.protect()));
      seen.length = 0;
      failUnprotect = true;
      const failed = yield* Effect.exit(stack.deploy(Guarded("Guard", { revision: 2 })));
      expect(Exit.isFailure(failed)).toBe(true);

      // The failed update stored desired destroy on its updating row but
      // retained protect on the last successful 'old' snapshot (#3411).
      failUnprotect = false;
      seen.length = 0;
      yield* stack.deploy(Guarded("Guard", { revision: 3 }));
      expect(seen.some((entry) => entry.phase === "diff" && entry.protected)).toBe(true);
      expect(seen.some((entry) => entry.phase === "reconcile" && entry.protected)).toBe(true);

      seen.length = 0;
      yield* stack.deploy(Guarded("Guard", { revision: 4 }));
      expect(seen.every((entry) => entry.protected === false)).toBe(true);
      yield* stack.destroy();
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "a create resumed after an interrupted protected create stays protected",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      seen.length = 0;
      failUnprotect = false;

      // The create fails after its row was written as `creating` + protect.
      failCreate = true;
      const failed = yield* Effect.exit(
        stack.deploy(Guarded("Guard", { revision: 1 }).pipe(RemovalPolicy.protect())),
      );
      expect(Exit.isFailure(failed)).toBe(true);

      // Retried without protect, the create still carries the stored policy.
      failCreate = false;
      seen.length = 0;
      yield* stack.deploy(Guarded("Guard", { revision: 1 }));
      expect(seen.filter((entry) => entry.phase === "reconcile")).toEqual([
        { phase: "reconcile", protected: true },
      ]);

      // A protected row blocks destroy: release it first.
      yield* stack.deploy(Guarded("Guard", { revision: 2 }));
      yield* stack.destroy();
    }),
  { tags: ["unit", "local"] },
);
