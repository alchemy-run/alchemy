import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Stackit from "@alchemy.run/stackit";
import { alertPath } from "@alchemy.run/stackit/Observability/AlertEventSource";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as observability from "@distilled.cloud/stackit/observability";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { logLevel, stackitEnvironment, stackitTags } from "../helpers.ts";
import AlertsOtherProjectWorker, {
  OtherMetrics,
  otherProject,
} from "./fixtures/alerts-worker-other-project.ts";
import AlertsWorker, { AlwaysFiring, Metrics, Received } from "./fixtures/alerts-worker.ts";
import { expectGone, observeInstance, slow } from "./observability.ts";

const { test } = Test.make({
  providers: Layer.mergeAll(Stackit.providers(), Cloudflare.providers()),
});
const { executeWhenReady, getWhenReady } = Test;

const options = {
  tags: [...stackitTags("observability", "alerteventsource"), "provider:cloudflare"],
  timeout: 2_700_000,
};

const Stack = Effect.gen(function* () {
  const instance = yield* Metrics;
  yield* Received;
  yield* AlwaysFiring;
  const worker = yield* AlertsWorker;
  return { instance, url: worker.url.as<string>() };
});

test.provider.skipIf(slow)(
  "consumeAlerts delivers an instance's firing alert to a Worker",
  (stack) =>
    Effect.gen(function* () {
      const { projectId } = yield* stackitEnvironment;
      yield* stack.destroy();

      const { instance, url } = yield* stack.deploy(Stack);
      const base = url.replace(/\/+$/, "");
      const instanceId = instance.instanceId;
      const delivery = `${base}${alertPath({ LogicalId: "AlertEventSourceInstance" }, {})}`;

      // Out of band: a receiver and route at the Worker, with a token in the URL.
      const { data: receivers } = yield* observability.listAlertConfigReceivers({
        projectId,
        instanceId,
      });
      const receiver = receivers.find((live) => live.name.startsWith("alchemy-webhook-"));
      expect(receiver).toBeDefined();
      const { data: root } = yield* observability.listAlertConfigRoutes({ projectId, instanceId });
      expect(root.routes?.find((live) => live.receiver === receiver?.name)?.continue).toEqual(true);

      // A delivery without the token is rejected.
      yield* getWhenReady(base);
      const anonymous = yield* executeWhenReady(
        HttpClientRequest.post(delivery).pipe(
          HttpClientRequest.bodyJsonUnsafe({ status: "firing", alerts: [] }),
        ),
      );
      expect(anonymous.status).toBe(401);
      const forged = yield* executeWhenReady(
        HttpClientRequest.post(`${delivery}?token=not-the-token`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ status: "firing", alerts: [] }),
        ),
      );
      expect(forged.status).toBe(401);

      // The always-firing rule reaches the Worker through Alertmanager.
      const client = yield* HttpClient.HttpClient;
      const last = yield* client.get(`${base}/last`).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((body) => (body as { readonly last: string | null }).last),
        Effect.repeat({
          schedule: Schedule.spaced("15 seconds"),
          until: (value) => value !== null,
          times: 60,
        }),
      );
      expect(JSON.parse(last!)).toEqual({
        status: "firing",
        alertname: "AlchemyTestAlwaysFiring",
      });

      yield* stack.destroy();

      yield* expectGone(observeInstance(projectId, instanceId));
    }).pipe(logLevel),
  options,
);

test.provider.skipIf(slow || !otherProject)(
  "consumeAlerts adds its webhook on an instance in another project",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { instance } = yield* stack.deploy(
        Effect.gen(function* () {
          const instance = yield* OtherMetrics;
          yield* AlertsOtherProjectWorker;
          return { instance };
        }),
      );
      expect(instance.projectId).toEqual(otherProject);

      // Out of band: the receiver and route are in the instance's project, not the profile's.
      const scope = { projectId: otherProject!, instanceId: instance.instanceId };
      const { data: receivers } = yield* observability.listAlertConfigReceivers(scope);
      const receiver = receivers.find((live) => live.name.startsWith("alchemy-webhook-"));
      expect(receiver).toBeDefined();
      const { data: root } = yield* observability.listAlertConfigRoutes(scope);
      expect(root.routes?.find((live) => live.receiver === receiver?.name)?.continue).toEqual(true);

      yield* stack.destroy();

      yield* expectGone(observeInstance(otherProject!, instance.instanceId));
    }).pipe(logLevel),
  options,
);
