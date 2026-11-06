import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectUrlContains } from "../Utils/Http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const tags = ["provider:cloudflare", "provider:cloudflare:ai", "live"];

const callerScript = `export default {
  async fetch(request, env) {
    return new Response("dataset:" + env.DATASET);
  },
};`;

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "AiDatasetLookupTarget",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const gateway = yield* Cloudflare.AI.Gateway("lookup-target-gateway", {
      id: testName("alchemy-aigw-dataset-lookup"),
    });
    const dataset = yield* Cloudflare.AI.Dataset("lookup-target", {
      gatewayId: gateway.gatewayId,
      filters: [{ key: "success", operator: "eq", value: [true] }],
    });
    return {
      gatewayId: gateway.gatewayId.as<string>(),
      datasetId: dataset.datasetId.as<string>(),
      name: dataset.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up dataset resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;
      const { gatewayId, datasetId, name } = yield* target;

      const program = Effect.gen(function* () {
        const byName = Cloudflare.AI.Dataset.lookup({ gatewayId, name });
        const byId = Cloudflare.AI.Dataset.lookup({ gatewayId, datasetId });
        const caller = yield* Cloudflare.Worker("dataset-lookup-caller", {
          script: callerScript,
          workersDev: true,
          env: { DATASET: byName.datasetId },
        });
        return { url: caller.url.as<string>(), byIdName: byId.name };
      });
      const out = yield* stack.deploy(program);
      expect(out.byIdName).toBe(name);

      yield* expectUrlContains(out.url, `dataset:${datasetId}`, {
        label: "dataset lookup caller",
      });

      const plan = yield* stack.plan(program);
      expect(plan.resources["dataset-lookup-caller"].action).toBe("noop");

      yield* stack.destroy();
      const survivor = yield* aiGateway.getDataset({ accountId, gatewayId, id: datasetId });
      expect(survivor.name).toBe(name);
    }),
  { tags, timeout: 240_000 },
);

test.provider(
  "a lookup of a missing dataset fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { gatewayId } = yield* target;
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          Cloudflare.Worker("dataset-lookup-missing", {
            script: callerScript,
            env: { DATASET: Cloudflare.AI.Dataset.lookup({ gatewayId, name }).datasetId },
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a dataset this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { gatewayId } = yield* target;
      const managed = () =>
        Cloudflare.AI.Dataset("lookup-managed", {
          gatewayId,
          filters: [{ key: "success", operator: "eq", value: [false] }],
        });
      const { datasetId } = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* Cloudflare.Worker("dataset-lookup-managed-caller", {
              script: callerScript,
              env: { DATASET: Cloudflare.AI.Dataset.lookup({ gatewayId, datasetId }).datasetId },
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
