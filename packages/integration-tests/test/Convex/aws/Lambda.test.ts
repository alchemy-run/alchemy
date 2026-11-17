import * as AWS from "@alchemy.run/aws";
import * as Convex from "@alchemy.run/convex";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import ConvexBindingLambda from "../fixtures/lambda.ts";
import { BindingDeployment } from "../fixtures/resources.ts";
import { FIXTURE_DIR } from "../support.ts";
import { assertDevAccount } from "./guard.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Convex.providers(), AWS.providers()),
});

test.provider(
  "bindings run from a deployed Lambda",
  (stack) =>
    Effect.gen(function* () {
      yield* assertDevAccount;
      yield* stack.destroy();
      const { url, deploymentUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          const deployment = yield* BindingDeployment;
          yield* Convex.Functions("BindingFunctions", { deployment, rootDir: FIXTURE_DIR });
          const fn = yield* ConvexBindingLambda;
          return { url: fn.functionUrl, deploymentUrl: deployment.url };
        }),
      );

      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const get = (path: string) =>
        http.get(new URL(path, url!).toString()).pipe(
          Effect.retry({ schedule: Schedule.exponential("500 millis"), times: 8 }),
          Effect.flatMap((response) => response.json),
        );

      expect(yield* get("/connect")).toEqual({ url: deploymentUrl });
      const rows = (yield* get("/add")) as Array<{ body: string }>;
      expect(rows.map((row) => row.body)).toContain("from a lambda");
      expect(yield* get("/usage")).toEqual({ hasCalls: true });

      yield* stack.destroy();
    }),
  {
    tags: ["provider:convex", "provider:convex:bindings", "provider:aws", "live"],
    timeout: 300_000,
  },
);
