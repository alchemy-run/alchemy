import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { expectGone, pinnedName } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const tagExists = (tagId: string) =>
  galaxy.tag.getTag({ tagId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

test.provider(
  "create, recolor, rename, look up and delete a tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const renamed = yield* pinnedName("tag");

      const created = yield* stack.deploy(StarburstGalaxy.Tag("Tag", { color: "#FF0000" }));
      const tagId = created.tagId;
      const live = yield* galaxy.tag.getTag({ tagId });
      expect(live.name).toBe(created.name);
      expect(live.color).toBe("#FF0000");

      // Every prop converges in place, the name included.
      const changed = yield* stack.deploy(
        StarburstGalaxy.Tag("Tag", { name: renamed, color: "#00FF00", description: "public" }),
      );
      expect(changed.tagId).toBe(tagId);
      const changedLive = yield* galaxy.tag.getTag({ tagId });
      expect(changedLive.name).toBe(renamed);
      expect(changedLive.color).toBe("#00FF00");
      expect(changedLive.description).toBe("public");

      const provider = yield* Provider.findProvider(StarburstGalaxy.Tag);
      const found = yield* provider.lookup!({ name: renamed });
      expect(found?.tagId).toBe(tagId);

      yield* stack.destroy();
      yield* expectGone(tagExists(tagId));
    }),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:tag", "live"],
    timeout: 90_000,
  },
);
