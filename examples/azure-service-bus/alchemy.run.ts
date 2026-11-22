import * as Azure from "@alchemy.run/azure";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import Api from "./src/Api.ts";
import { Audit, Bus, Events, Notify, Orders, Results } from "./src/resources.ts";
import Worker from "./src/Worker.ts";

export default Alchemy.Stack(
  "AzureServiceBusExample",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const bus = yield* Bus;
    const orders = yield* Orders;
    const events = yield* Events;
    const audit = yield* Audit;
    const notify = yield* Notify;
    const results = yield* Results;
    const api = yield* Api;
    const worker = yield* Worker;

    return {
      url: api.url,
      resourceGroup: bus.resourceGroup,
      namespaceName: bus.namespaceName,
      queueName: orders.queueName,
      topicName: events.topicName,
      subscriptionNames: [audit.subscriptionName, notify.subscriptionName],
      storageAccountName: results.storageAccount,
      containerName: results.containerName,
      apiApp: api.functionAppName,
      workerApp: worker.functionAppName,
    };
  }),
);
