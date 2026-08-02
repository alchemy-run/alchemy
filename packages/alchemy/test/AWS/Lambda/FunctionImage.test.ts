import {
  functionImagePlatform,
  hashFunctionImageBuild,
} from "@/AWS/Lambda/FunctionImage.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const describe = layer(NodeServices.layer);

describe("Lambda Function images", (it) => {
  it.effect("maps Lambda architectures to Docker platforms", () =>
    Effect.sync(() => {
      expect(functionImagePlatform("x86_64")).toBe("linux/amd64");
      expect(functionImagePlatform("arm64")).toBe("linux/arm64");
    }),
  );

  it.effect("does not hash files excluded by .dockerignore", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-hash-",
      });
      yield* fs.writeFileString(
        path.join(context, "Dockerfile"),
        "FROM scratch\nCOPY . /app\n",
      );
      yield* fs.makeDirectory(path.join(context, "ignored"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(context, ".dockerignore"),
        "ignored/**\n!ignored/included.txt\n",
      );
      yield* fs.writeFileString(
        path.join(context, "ignored", "excluded.txt"),
        "one",
      );
      yield* fs.writeFileString(
        path.join(context, "ignored", "included.txt"),
        "one",
      );

      const source = { context, dockerfile: "Dockerfile" };
      const initial = yield* hashFunctionImageBuild(source, "x86_64");
      yield* fs.writeFileString(
        path.join(context, "ignored", "excluded.txt"),
        "two",
      );
      expect(yield* hashFunctionImageBuild(source, "x86_64")).toBe(initial);

      yield* fs.writeFileString(
        path.join(context, "ignored", "included.txt"),
        "two",
      );
      expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(initial);
    }),
  );

  it.effect(
    "hashes Dockerfile, build args, architecture, and relative context contents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-lambda-image-inputs-",
        });
        const first = path.join(root, "first");
        const second = path.join(root, "second");
        yield* fs.makeDirectory(first, { recursive: true });
        yield* fs.makeDirectory(second, { recursive: true });

        for (const context of [first, second]) {
          yield* fs.writeFileString(
            path.join(context, "Dockerfile"),
            "FROM scratch\nCOPY app.txt /app.txt\n",
          );
          yield* fs.writeFileString(path.join(context, "app.txt"), "hello");
        }

        const source = {
          context: first,
          dockerfile: "Dockerfile",
          buildArgs: { B: "two", A: "one" },
        };
        const initial = yield* hashFunctionImageBuild(source, "x86_64");
        expect(
          yield* hashFunctionImageBuild(
            {
              context: second,
              dockerfile: "Dockerfile",
              buildArgs: { A: "one", B: "two" },
            },
            "x86_64",
          ),
        ).toBe(initial);
        expect(
          yield* hashFunctionImageBuild(
            {
              ...source,
              buildArgs: { A: "changed", B: "two" },
            },
            "x86_64",
          ),
        ).not.toBe(initial);
        expect(yield* hashFunctionImageBuild(source, "arm64")).not.toBe(
          initial,
        );

        yield* fs.writeFileString(
          path.join(first, "Dockerfile"),
          "FROM scratch\nCOPY app.txt /renamed.txt\n",
        );
        expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(
          initial,
        );
      }),
  );

  it.effect(
    "uses a Dockerfile-specific ignore file instead of the context root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const context = yield* fs.makeTempDirectoryScoped({
          prefix: "alchemy-lambda-image-ignore-",
        });
        yield* fs.writeFileString(
          path.join(context, "Lambda.Dockerfile"),
          "FROM scratch\nCOPY . /app\n",
        );
        yield* fs.writeFileString(
          path.join(context, ".dockerignore"),
          "root-only.txt\n",
        );
        yield* fs.writeFileString(
          path.join(context, "Lambda.Dockerfile.dockerignore"),
          "specific-only.txt\n",
        );
        yield* fs.writeFileString(
          path.join(context, "specific-only.txt"),
          "one",
        );
        yield* fs.writeFileString(path.join(context, "root-only.txt"), "one");

        const source = { context, dockerfile: "Lambda.Dockerfile" };
        const initial = yield* hashFunctionImageBuild(source, "x86_64");
        yield* fs.writeFileString(
          path.join(context, "specific-only.txt"),
          "two",
        );
        expect(yield* hashFunctionImageBuild(source, "x86_64")).toBe(initial);

        yield* fs.writeFileString(path.join(context, "root-only.txt"), "two");
        expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(
          initial,
        );
      }),
  );

  it.effect("requires an explicit Dockerfile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* fs.makeTempDirectoryScoped({
        prefix: "alchemy-lambda-image-schema-",
      });
      const result = yield* Effect.result(
        hashFunctionImageBuild({ context } as any, "x86_64"),
      );
      expect(Result.isFailure(result)).toBe(true);
    }),
  );
});
