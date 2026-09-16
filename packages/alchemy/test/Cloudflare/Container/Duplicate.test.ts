import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { application } from "./fixtures/configuration/application.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

test.provider(
  "duplicate container names return a typed conflict",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const source = yield* stack.deploy(application({ maxInstances: 1 }));
      const result = yield* Containers.createContainerApplication({
        accountId: source.accountId,
        name: source.applicationName,
        instances: 0,
        maxInstances: 1,
        schedulingPolicy: "default",
        constraints: {},
        configuration: source.configuration,
      }).pipe(Effect.result);
      if (
        Result.isSuccess(result) &&
        result.success.id !== source.applicationId
      ) {
        yield* Containers.deleteContainerApplication({
          accountId: source.accountId,
          applicationId: result.success.id,
        });
      }
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        if (result.failure._tag !== "ContainerApplicationAlreadyExists")
          return yield* Effect.fail(result.failure);
        expect(result.failure._tag).toBe("ContainerApplicationAlreadyExists");
      }
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
