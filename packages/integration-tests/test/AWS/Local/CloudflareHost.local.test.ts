import * as AWS from "@alchemy.run/aws";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import RemoteQueueWorker from "./fixtures/cloudflare-host/worker.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Cloudflare.providers(), AWS.providers()),
  dev: true,
});

test.provider(
  "a local Worker calling a real-cloud AWS resource is rejected by name before anything is created",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const exit = yield* stack.deploy(RemoteQueueWorker).pipe(Effect.exit);
      const defects = Exit.isFailure(exit)
        ? exit.cause.reasons.flatMap((reason) =>
            reason._tag === "Die" ? [reason.defect as { _tag?: string }] : [],
          )
        : [];
      expect(defects).toContainEqual(
        expect.objectContaining({
          _tag: "UnbridgedDevEdge",
          from: "RemoteQueueWorker",
          to: "CloudflareHostQueue",
          edge: "call",
        }),
      );
      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:cloudflare", "local"], timeout: 120_000 },
);
