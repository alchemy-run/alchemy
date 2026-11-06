import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as stream from "@distilled.cloud/cloudflare/stream";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails } from "../../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:stream", "live"];

const callerScript = `export default {
  async fetch() {
    return new Response("ok");
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
// It is declared without props, which must work: every prop is optional.
const TargetStack = Alchemy.Stack(
  "StreamLiveInputLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const input = yield* Cloudflare.Stream.LiveInput("lookup-target");
    return { liveInputId: input.liveInputId.as<string>() };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up live input takes a new output, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { liveInputId } = yield* target;

      const program = Effect.gen(function* () {
        const input = Cloudflare.Stream.LiveInput.lookup({ liveInputId });
        const output = yield* Cloudflare.Stream.LiveInputOutput("live-input-lookup-output", {
          liveInputId: input.liveInputId,
          url: "rtmps://a.rtmps.youtube.com/live2",
          streamKey: "alchemy-test-stream-key",
        });
        return { outputId: output.outputId };
      });
      const out = yield* stack.deploy(program);

      const outputs = yield* stream.listLiveInputOutputs({
        accountId,
        liveInputIdentifier: liveInputId,
      });
      expect(outputs.result.map((o) => o.uid)).toContain(out.outputId);

      // A lookup re-resolves to the same input, so nothing changes.
      const plan = yield* stack.plan(program);
      expect(plan.resources["live-input-lookup-output"].action).toBe("noop");

      // Destroying the stack removes its output but leaves the input.
      yield* stack.destroy();
      const survivor = yield* stream.getLiveInput({ accountId, liveInputIdentifier: liveInputId });
      expect(survivor.uid).toBe(liveInputId);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing live input fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const liveInputId = "00000000000000000000000000000000";
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("live-input-lookup-missing", {
            script: callerScript,
            env: { REF: Cloudflare.Stream.LiveInput.lookup({ liveInputId }).liveInputId },
          }),
        ),
        ["LookupNotFoundError", liveInputId],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a live input this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => Cloudflare.Stream.LiveInput("lookup-managed");
      const { liveInputId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("live-input-lookup-managed-caller", {
              script: callerScript,
              env: { REF: Cloudflare.Stream.LiveInput.lookup({ liveInputId }).liveInputId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
