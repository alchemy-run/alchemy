import * as DigitalOcean from "@alchemy.run/digitalocean";
import { ignoreNotFound } from "@alchemy.run/digitalocean/internal/notFound";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { createTag, deleteTag, getTag } from "@distilled.cloud/digitalocean";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { isGone, logLevel, testName } from "./support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:tag", "live"];
const LIVE_TIMEOUT = 120_000;

const isTagGone = (name: string) => isGone(getTag({ tag_id: name }));

test.provider(
  "tag lifecycle: create, replace on a new name, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "tag");
      const renamed = testName(stack.stage, "tag-renamed");

      const created = yield* stack.deploy(DigitalOcean.Tag("Web", { name }));
      expect(created).toEqual({ name, resourceCount: 0 });

      yield* stack.deploy(DigitalOcean.Tag("Web", { name: renamed }));
      expect(yield* isTagGone(name)).toBe(true);
      expect(yield* isTagGone(renamed)).toBe(false);

      yield* stack.destroy();

      expect(yield* isTagGone(renamed)).toBe(true);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a tag with the reserved alchemy: prefix is refused",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const refused = yield* stack
        .deploy(DigitalOcean.Tag("Reserved", { name: "alchemy:mine" }))
        .pipe(Effect.flip);
      expect(refused).toBeInstanceOf(DigitalOcean.TagNameReserved);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a tag that already exists needs adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "tag-foreign");

      yield* Effect.acquireUseRelease(
        createTag({ name }),
        () =>
          Effect.gen(function* () {
            const refused = yield* stack
              .deploy(DigitalOcean.Tag("Adopted", { name }))
              .pipe(Effect.flip);
            expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

            yield* stack.deploy(DigitalOcean.Tag("Adopted", { name }).pipe(adopt(true)));
            yield* stack.destroy();

            expect(yield* isTagGone(name)).toBe(true);
          }),
        () => ignoreNotFound(deleteTag({ tag_id: name })),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
