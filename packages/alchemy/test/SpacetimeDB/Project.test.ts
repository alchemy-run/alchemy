import { Project, ProjectProvider } from "@/SpacetimeDB/Project.ts";
import * as Provider from "@/Provider.ts";
import { AlchemyContext } from "@/AlchemyContext.ts";
import { InstanceId } from "@/InstanceId.ts";
import { Stack } from "@/Stack.ts";
import { Stage } from "@/Stage.ts";
import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

const testLayer = () =>
  Layer.mergeAll(
    ProjectProvider(),
    Layer.succeed(Stage, "test"),
    Layer.succeed(Stack, {
      name: "test",
      stage: "test",
      resources: {},
      bindings: {},
      actions: {},
    }),
    Layer.succeed(AlchemyContext, {
      dev: false,
      adopt: false,
      dotAlchemy: ".alchemy",
    }),
    Layer.succeed(InstanceId, "0123456789abcdef0123456789abcdef"),
    NodeServices.layer,
  );

describe("SpacetimeDB.Project", () => {
  it.effect("writes spacetime.json with children and local override", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "stdb-project-" });

      const provider = yield* Provider.findProvider(Project);
      const out = yield* provider.reconcile({
        id: "Worlds",
        fqn: "Worlds",
        news: {
          database: "world-highlands",
          configDir: dir,
          modulePath: "./world-module",
          server: "maincloud",
          generate: [
            { language: "typescript", outDir: "./client/src/bindings" },
          ],
          children: [
            { database: "world-midlands" },
            { database: "world-coastlands" },
          ],
          devRun: "pnpm dev",
        },
        olds: undefined,
        output: undefined,
        bindings: [],
      } as any);

      expect(out.databases).toEqual([
        "world-highlands",
        "world-midlands",
        "world-coastlands",
      ]);
      expect(out.configPath).toBe(path.join(dir, "spacetime.json"));
      expect(out.localConfigPath).toBe(path.join(dir, "spacetime.local.json"));

      const raw = yield* fs.readFileString(out.configPath);
      const json = JSON.parse(raw) as {
        database: string;
        children: { database: string }[];
        dev: { run: string };
      };
      expect(json.database).toBe("world-highlands");
      expect(json.children.map((c) => c.database)).toEqual([
        "world-midlands",
        "world-coastlands",
      ]);
      expect(json.dev.run).toBe("pnpm dev");

      const local = JSON.parse(
        yield* fs.readFileString(out.localConfigPath!),
      ) as { database: string };
      expect(local.database).toBe("world-highlands-local");
    }).pipe(Effect.provide(testLayer())),
  );
});
