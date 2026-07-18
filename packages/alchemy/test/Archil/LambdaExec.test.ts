import * as Archil from "@/Archil";
import * as AWS from "@/AWS";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import ArchilExecFunctionLive, {
  ArchilExecFunction,
} from "./fixtures/exec-lambda.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(AWS.providers(), Archil.providers()),
});

const hasArchil = !!process.env.ARCHIL_API_KEY;

test.provider.skipIf(!hasArchil)(
  "deployed Lambda runs bash on a disk via the same Exec binding",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { functionUrl } = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ArchilExecFunction;
        }).pipe(Effect.provide(ArchilExecFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      const baseUrl = functionUrl!.replace(/\/+$/, "");

      const client = yield* HttpClient.HttpClient;
      // Lambda function URLs take a few seconds to start serving; retry the
      // first request and assert on the parsed payload.
      const exec = yield* client.get(`${baseUrl}/exec`).pipe(
        Effect.flatMap((res) => res.json),
        Effect.map((body) => body as unknown as Archil.ExecResult),
        Effect.filterOrFail(
          (r): boolean => typeof r.exitCode === "number",
          (r) => new Error(`unexpected body: ${JSON.stringify(r)}`),
        ),
        Effect.retry({
          schedule: Schedule.exponential("1 second", 1.5),
          times: 10,
        }),
      );

      expect(exec.exitCode).toBe(0);
      expect(exec.stdout.trim()).toBe("lambda-was-here");

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
