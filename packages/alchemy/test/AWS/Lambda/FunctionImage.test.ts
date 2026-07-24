import { hashFunctionImageBuild } from "@/AWS/Lambda/FunctionImage.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";

const describe = layer(NodeServices.layer);

describe("Lambda Function image hashing", (it) => {
  it.effect("hashes every file in the Docker build context", () =>
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
      yield* fs.writeFileString(path.join(context, "app.txt"), "one");

      const source = { context, dockerfile: "Dockerfile" };
      const initial = yield* hashFunctionImageBuild(source, "x86_64");
      yield* fs.writeFileString(path.join(context, "app.txt"), "two");
      const updated = yield* hashFunctionImageBuild(source, "x86_64");
      expect(updated).not.toBe(initial);
      yield* fs.writeFileString(
        path.join(context, ".dockerignore"),
        "app.txt\n",
      );
      expect(yield* hashFunctionImageBuild(source, "x86_64")).not.toBe(updated);
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
