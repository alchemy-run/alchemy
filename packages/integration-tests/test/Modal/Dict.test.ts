import * as Modal from "@alchemy.run/modal";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as dict from "@distilled.cloud/modal/dict";
import * as Effect from "effect/Effect";
import { expectFound } from "./lookup.ts";

const { test } = Test.make({ providers: Modal.providers() });

const exists = (id: string) =>
  dict.dictGetById({ dictId: id }).pipe(
    Effect.map(() => true),
    Effect.catchTag("DictNotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, keep on redeploy, replace on rename, and delete a dict",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Dict("Dict", {});
        }),
      );
      yield* expectFound(Modal.Dict.lookup({ name: first.name }), first);
      expect(yield* exists(first.dictId)).toBe(true);

      const again = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Dict("Dict", {});
        }),
      );
      expect(again.dictId).toBe(first.dictId);

      const renamed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Modal.Dict("Dict", { name: `${first.name.slice(0, 61)}-b` });
        }),
      );
      expect(renamed.dictId).not.toBe(first.dictId);
      expect(yield* exists(first.dictId)).toBe(false);

      yield* stack.destroy();
      expect(yield* exists(renamed.dictId)).toBe(false);
    }),
  { tags: ["provider:modal", "provider:modal:dict", "live"], timeout: 120_000 },
);
