import * as AWS from "@/AWS";
import { Repository } from "@/AWS/ECR/Repository.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection): deploy a real
// repository, resolve the provider from context via the typed `findProvider`,
// call `list()`, and assert the deployed repository appears in the
// exhaustively-paginated result.
test.provider("list enumerates the deployed repository", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const repo = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Repository("ListRepository", {
          repositoryName: "alchemy-test-ecr-repo-list",
        });
      }),
    );

    const provider = yield* Provider.findProvider(Repository);
    const all = yield* provider.list();

    expect(all.some((r) => r.repositoryName === repo.repositoryName)).toBe(
      true,
    );

    yield* stack.destroy();
  }),
);
