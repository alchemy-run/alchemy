import * as AWS from "@alchemy.run/aws";
import * as Stripe from "@alchemy.run/stripe";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as SQS from "@distilled.cloud/aws/sqs";
import {
  CreateCoreEventDestinationPing,
  CreateCustomer,
  DeleteCustomer,
  GetCoreEventDestinations,
} from "@distilled.cloud/stripe/stripe";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import StripeEventBridgeFunction, {
  Deliveries,
  DeliveriesLive,
} from "./fixtures/event-bridge-function.ts";

const providers = () => Layer.mergeAll(AWS.providers(), Stripe.providers());

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({ providers: providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const Stack = Alchemy.Stack(
  "StripeEventBridgeTestStack",
  { providers: providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    yield* StripeEventBridgeFunction;
    const queue = yield* Deliveries;
    return { queueUrl: queue.queueUrl };
  }).pipe(Effect.provide(DeliveriesLive)),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

interface Delivery {
  type: string;
  id: string;
  related?: string;
}

/** Drain the delivery queue until one matching `predicate` arrives. */
const waitForDelivery = (queueUrl: string, predicate: (delivery: Delivery) => boolean) =>
  Effect.gen(function* () {
    const result = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
    });
    let found: Delivery | undefined;
    for (const message of result.Messages ?? []) {
      const delivery = JSON.parse(message.Body ?? "{}") as Delivery;
      if (predicate(delivery)) found = delivery;
      if (message.ReceiptHandle) {
        yield* SQS.deleteMessage({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle });
      }
    }
    return found;
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (found) => found !== undefined,
      times: 30,
    }),
  );

const tags = [
  "provider:aws",
  "provider:aws:eventbridge",
  "provider:aws:lambda",
  "provider:stripe",
  "provider:stripe:eventdestination",
  "live",
];

test.provider(
  "a snapshot event reaches the Lambda through EventBridge",
  () =>
    Effect.gen(function* () {
      const { queueUrl } = yield* stack;
      const customer = yield* CreateCustomer({ email: "alchemy.eventbridge@example.com" });
      const delivery = yield* waitForDelivery(
        queueUrl,
        (d) => d.type === "customer.created" && d.id === customer.id,
      );
      expect(delivery?.id).toEqual(customer.id);
      yield* DeleteCustomer({ customer: customer.id });
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);

test.provider(
  "a thin event is fetched and handled on the Lambda through EventBridge",
  () =>
    Effect.gen(function* () {
      const { queueUrl } = yield* stack;
      const destinations = yield* GetCoreEventDestinations({ limit: 20 });
      const destination = destinations.data.find(
        (d) =>
          d.type === "amazon_eventbridge" &&
          d.event_payload === "thin" &&
          d.metadata?.[Stripe.alchemyMetadataKeys.stack] === "StripeEventBridgeTestStack",
      );
      expect(destination?.amazon_eventbridge?.aws_event_source_status).toEqual("active");

      const ping = yield* CreateCoreEventDestinationPing({ id: destination!.id });
      const delivery = yield* waitForDelivery(queueUrl, (d) => d.id === ping.id);
      expect(delivery).toEqual({
        type: "v2.core.event_destination.ping",
        id: ping.id,
        related: destination!.id,
      });
    }).pipe(logLevel),
  { tags, timeout: 120_000 },
);
