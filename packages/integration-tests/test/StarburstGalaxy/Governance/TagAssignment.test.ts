import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, secret, UNVALIDATED_ENDPOINT } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const tagsOn = (catalogId: string) =>
  galaxy.discovery
    .getCatalogMetadata({ catalogId })
    .pipe(Effect.map((metadata) => metadata.tags.map((tag) => tag.tagId)));

test.provider(
  "apply a tag to a catalog, move it to another tag, and remove it",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);

      const app = (which: "A" | "B") =>
        Effect.gen(function* () {
          // Both tags stay deployed across the replacement.
          const a = yield* StarburstGalaxy.Governance.Tag("TagA", { color: "#FF0000" });
          const b = yield* StarburstGalaxy.Governance.Tag("TagB", { color: "#0000FF" });
          const catalog = yield* StarburstGalaxy.Catalog.PostgresqlCatalog("Catalog", {
            endpoint: UNVALIDATED_ENDPOINT,
            databaseName: "app",
            username: "galaxy",
            password: secret("tag-catalog"),
            validate: false,
          });
          const assignment = yield* StarburstGalaxy.Governance.TagAssignment("Assignment", {
            tag: which === "A" ? a.tagId : b.tagId,
            catalog: catalog.catalogId,
          });
          return { a, b, catalog, assignment };
        });

      const first = yield* stack.deploy(app("A"));
      const catalogId = first.catalog.catalogId;
      expect(first.assignment.tagName).toBe(first.a.name);
      const onA = yield* tagsOn(catalogId);
      expect(onA).toEqual([first.a.tagId]);

      // Another tag replaces the assignment: the old tag comes off.
      const second = yield* stack.deploy(app("B"));
      expect(second.assignment.tagId).toBe(second.b.tagId);
      const onB = yield* tagsOn(catalogId);
      expect(onB).toEqual([second.b.tagId]);

      // Destroy removes the assignment before its tags and catalog.
      yield* stack.destroy();
      yield* expectGone(
        galaxy.tag.getTag({ tagId: second.b.tagId }).pipe(
          Effect.as(true),
          Effect.catchTag("NotFound", () => Effect.succeed(false)),
        ),
      );
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:tag", "live"],
    timeout: 420_000,
  },
);
