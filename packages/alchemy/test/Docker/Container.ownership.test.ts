import { OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Docker from "@/Docker";
import { inMemoryState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({
  providers: Docker.providers(),
  state: inMemoryState(),
  adopt: false,
});

describe("Docker.Container ownership", { concurrent: false }, () => {
  test.provider(
    "refuses to replace a foreign container under the same name",
    (stack) =>
      Effect.gen(function* () {
        const docker = yield* Docker.Docker;
        const name = "alchemy-test-foreign-container";
        yield* Effect.addFinalizer(() =>
          docker.container.remove(name, true).pipe(Effect.ignore),
        );
        const { stdout: foreignId } = yield* docker.run([
          "container",
          "create",
          "--name",
          name,
          "nginx:alpine",
        ]);

        const result = yield* Effect.result(
          stack.deploy(
            Docker.Container("foreign-container", {
              name,
              image: "alpine:3.19",
            }),
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(OwnedBySomeoneElse);
        }

        const info = yield* docker.container.inspect(name);
        expect(info.Id).toBe(foreignId);
        expect(info.Config.Image).toBe("nginx:alpine");
        expect(info.Config.Labels ?? {}).not.toHaveProperty("alchemy::id");
      }),
  );
});
