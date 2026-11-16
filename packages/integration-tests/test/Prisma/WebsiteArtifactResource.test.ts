import { WebsiteArtifact, WebsiteArtifactProvider } from "@alchemy.run/prisma/Website/Artifact";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

class WebsiteArtifactTestProviders extends Provider.ProviderCollection<WebsiteArtifactTestProviders>()(
  "Prisma",
) {}

const { test } = Test.make({
  providers: Layer.effect(
    WebsiteArtifactTestProviders,
    Provider.collection([WebsiteArtifact]),
  ).pipe(
    Layer.provideMerge(WebsiteArtifactProvider()),
    Layer.provide(
      Layer.succeed(AlchemyContext, { dotAlchemy: ".alchemy-test", dev: false, adopt: false }),
    ),
  ),
});

const mtime = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return (yield* fs.stat(file)).mtime;
  });

test.provider(
  "skips staging when the build output is unchanged, and restages when it changes",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* stack.destroy();
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-prisma-website-" });
      const dist = path.join(root, "dist");
      yield* fs.makeDirectory(dist);
      yield* fs.writeFileString(path.join(dist, "index.html"), "<h1>one</h1>");
      const program = WebsiteArtifact("Site", { root, distDir: dist, static: {} });

      const first = yield* stack.deploy(program);
      const firstWrite = yield* mtime(first.artifactPath);

      const second = yield* stack.deploy(program);
      expect(second.artifactPath).toBe(first.artifactPath);
      expect(second.hash).toBe(first.hash);
      expect(yield* mtime(second.artifactPath)).toEqual(firstWrite);
      expect(path.isAbsolute(second.artifactPath)).toBe(false);

      // A CI runner starts without the `.alchemy` directory that holds it.
      yield* fs.remove(second.directory, { recursive: true });
      const restored = yield* stack.deploy(program);
      expect(restored.artifactPath).toBe(first.artifactPath);
      expect(restored.hash).toBe(first.hash);

      yield* fs.writeFileString(path.join(dist, "index.html"), "<h1>two</h1>");
      const third = yield* stack.deploy(program);
      expect(third.hash).not.toBe(first.hash);
      expect(yield* fs.exists(first.artifactPath)).toBe(false);

      yield* stack.destroy();
      expect(yield* fs.exists(third.directory)).toBe(false);
    }).pipe(Effect.scoped),
  { tags: ["unit", "local", "provider:prisma", "provider:prisma:website"] },
);
