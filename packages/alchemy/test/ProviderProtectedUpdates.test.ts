import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Provider from "@/Provider.ts";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import { Resource } from "@/Resource.ts";
import { inMemoryState } from "@/State/index.ts";

interface Guarded extends Resource<
  "Test.Guarded",
  {
    revision: number;
    /** A change replaces the resource. */
    generation?: number;
    /** Stands in for a destructive change a provider refuses while protected. */
    destructive?: boolean;
  },
  { revision: number }
> {}
const Guarded = Resource<Guarded>("Test.Guarded");

const seen: Array<{ phase: "diff" | "reconcile"; protected: boolean | undefined }> = [];
let failUnprotect = false;
let failCreate = false;
let failDelete = false;
const { test } = Test.make({
  state: inMemoryState(),
  providers: Provider.succeed(Guarded, {
    list: () => Effect.succeed([]),
    diff: ({ news, olds, protected: protectedFromDeletion }) =>
      Effect.sync(() => {
        seen.push({ phase: "diff", protected: protectedFromDeletion });
        return {
          action:
            olds !== undefined && (news as { generation?: number }).generation !== olds.generation
              ? ("replace" as const)
              : ("update" as const),
        };
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
        if (news.destructive && protectedFromDeletion) {
          return yield* Effect.fail({
            _tag: "RefusedWhileProtected",
            message: "refused a destructive change while protected",
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
    delete: () =>
      failDelete
        ? Effect.fail({ _tag: "InjectedDeleteFailure", message: "injected failed delete" })
        : Effect.void,
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

      yield* stack.deploy(Guarded("Guard", { revision: 2 }));
      yield* stack.destroy();
    }),
  { tags: ["unit", "local"] },
);

const reconciles = () =>
  seen.filter((entry) => entry.phase === "reconcile").map((entry) => entry.protected);

test.provider(
  "a refused change keeps a resumed create protected on every retry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      failCreate = true;
      yield* Effect.exit(
        stack.deploy(Guarded("Guard", { revision: 1 }).pipe(RemovalPolicy.protect())),
      );
      failCreate = false;

      // Dropping protect() together with a destructive change is refused, and
      // the refused attempt must not checkpoint the row as unprotected.
      seen.length = 0;
      for (const _ of [1, 2]) {
        const retry = yield* Effect.exit(
          stack.deploy(Guarded("Guard", { revision: 1, destructive: true })),
        );
        expect(Exit.isFailure(retry)).toBe(true);
      }
      expect(reconciles()).toEqual([true, true]);

      yield* stack.deploy(Guarded("Guard", { revision: 1 }));
      yield* stack.destroy();
    }),
  { tags: ["unit", "local"] },
);

test.provider(
  "a refused change keeps a draining replaced row protected on every retry",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* stack.deploy(Guarded("Guard", { revision: 1, generation: 1 }));
      // Replace while the old generation can't be deleted: the row stays
      // `replaced`, draining it. Then protect the current generation.
      failDelete = true;
      yield* Effect.exit(stack.deploy(Guarded("Guard", { revision: 1, generation: 2 })));
      yield* Effect.exit(
        stack.deploy(
          Guarded("Guard", { revision: 1, generation: 2 }).pipe(RemovalPolicy.protect()),
        ),
      );

      seen.length = 0;
      for (const _ of [1, 2]) {
        const retry = yield* Effect.exit(
          stack.deploy(Guarded("Guard", { revision: 2, generation: 2, destructive: true })),
        );
        expect(Exit.isFailure(retry)).toBe(true);
      }
      expect(reconciles()).toEqual([true, true]);

      failDelete = false;
      yield* stack.deploy(Guarded("Guard", { revision: 2, generation: 2 }));
      yield* stack.destroy();
    }),
  { tags: ["unit", "local"] },
);
