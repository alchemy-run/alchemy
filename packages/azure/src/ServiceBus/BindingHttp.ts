import * as messaging from "@distilled.cloud/azure/servicebus-messaging";
import * as Effect from "effect/Effect";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Queue } from "./Queue.ts";
import type { SendServiceBusQueueClient, ServiceBusSendOptions } from "./QueueSend.ts";
import type {
  ReceiveServiceBusClient,
  ServiceBusBatchEntry,
  ServiceBusLockedMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiveOptions,
  WriteServiceBusClient,
} from "./ServiceBusTypes.ts";
import type { Subscription } from "./Subscription.ts";
import type { Topic } from "./Topic.ts";

/*
 * Shared scaffolding for the Service Bus data-plane bindings: resolves the
 * distilled `servicebus-messaging` operations once when the layer is built
 * and, at deploy time, assigns the binding's roles on the bound queue, topic
 * or subscription. NOT exported from `index.ts`.
 */

/**
 * The least-privilege roles of every Service Bus binding. Service Bus has
 * exactly two message data actions, and each built-in data role grants one
 * of them (plus `queues/read`, `topics/read` and `topics/subscriptions/read`
 * on the entity), so no custom role is narrower:
 * https://learn.microsoft.com/azure/service-bus-messaging/service-bus-managed-service-identity#azure-built-in-roles-for-azure-service-bus
 */
export const ServiceBusGrants = {
  /** Send and Send Batch: the `send/action` data action (Azure Service Bus Data Sender). */
  send: [BuiltInRole.ServiceBusDataSender],
  /**
   * Peek-lock, receive-and-delete, complete, unlock and renew-lock:
   * the `receive/action` data action (Azure Service Bus Data Receiver).
   */
  receive: [BuiltInRole.ServiceBusDataReceiver],
  /** Both, as two assignments: Azure Service Bus Data Owner would also manage the entity. */
  sendReceive: [BuiltInRole.ServiceBusDataSender, BuiltInRole.ServiceBusDataReceiver],
} satisfies Record<string, ReadonlyArray<string>>;

/** A Service Bus entity a binding can be bound to. */
export type ServiceBusEntity = Queue | Topic | Subscription;

/** The ARM ID a binding's roles are assigned on: the entity itself. */
const scopeOf = (entity: ServiceBusEntity) =>
  entity.Type === "Azure.ServiceBus.Queue"
    ? entity.queueId
    : entity.Type === "Azure.ServiceBus.Topic"
      ? entity.topicId
      : entity.subscriptionResourceId;

const GrantOn = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  return Effect.fn(function* (tag: string, entity: ServiceBusEntity, roles: ReadonlyArray<string>) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const scope = scopeOf(entity);
      yield* bind`${tag}(${entity})`({
        roleAssignments: roles.map((roleDefinitionId) => ({ roleDefinitionId, scope })),
      });
    }
  });
});

/** The request members a bound queue supplies. */
export type QueueTarget = { namespaceName: string; queueName: string };
/** The request members a bound queue or topic supplies to a send. */
export type EntityTarget = { namespaceName: string; entityPath: string };
/** The request members a bound topic subscription supplies. */
export type SubscriptionTarget = {
  namespaceName: string;
  topicName: string;
  subscriptionName: string;
};

/** Resolves a target's request members per call at runtime. */
type Target<T> = Effect.Effect<T>;

const queueTarget = (queue: Queue) =>
  Effect.gen(function* () {
    const namespace = yield* queue.namespaceName;
    const name = yield* queue.queueName;
    return Effect.gen(function* () {
      const namespaceName = yield* namespace;
      const queueName = yield* name;
      return { namespaceName, queueName };
    }) satisfies Target<QueueTarget>;
  });

const entityTarget = (entity: Queue | Topic) =>
  Effect.gen(function* () {
    const namespace = yield* entity.namespaceName;
    const name =
      entity.Type === "Azure.ServiceBus.Queue" ? yield* entity.queueName : yield* entity.topicName;
    return Effect.gen(function* () {
      const namespaceName = yield* namespace;
      const entityPath = yield* name;
      return { namespaceName, entityPath };
    }) satisfies Target<EntityTarget>;
  });

const subscriptionTarget = (subscription: Subscription) =>
  Effect.gen(function* () {
    const namespace = yield* subscription.namespaceName;
    const topic = yield* subscription.topicName;
    const name = yield* subscription.subscriptionName;
    return Effect.gen(function* () {
      const namespaceName = yield* namespace;
      const topicName = yield* topic;
      const subscriptionName = yield* name;
      return { namespaceName, topicName, subscriptionName };
    }) satisfies Target<SubscriptionTarget>;
  });

/** A distilled operation resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

/**
 * Bind `op` to a target of type `T`: the callable injects the target's
 * request members and takes the rest.
 */
const onTarget =
  <T extends object>() =>
  <I extends T, A, E>(op: (input: I) => Effect.Effect<A, E>) =>
  (label: string, target: Target<T>) =>
    Effect.fn(label)(function* (request?: Omit<I, keyof T>) {
      const members = yield* target;
      // `Omit<I, keyof T> & T` is `I`; TS cannot prove it for a generic `I`.
      return yield* op({ ...request, ...members } as I);
    });

const onQueue = onTarget<QueueTarget>();
const onEntity = onTarget<EntityTarget>();
const onSubscription = onTarget<SubscriptionTarget>();

const makeOperationBinding =
  <R extends ServiceBusEntity, T extends object>(
    resolveTarget: (entity: R) => Effect.Effect<Target<T>>,
  ) =>
  <I extends T, A, E>(options: {
    /** Fully-qualified binding tag, e.g. `Azure.ServiceBus.SendMessage`. */
    tag: string;
    /** The distilled `servicebus-messaging` operation. */
    operation: Operation<I, A, E>;
    roles: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const grantOn = yield* GrantOn;
      const op = yield* AzureBindings.withCredentials(options.operation);
      const bound = onTarget<T>()(op);
      return Effect.fn(function* (entity: R) {
        yield* grantOn(options.tag, entity, options.roles);
        const target = yield* resolveTarget(entity);
        return bound(`${options.tag}(${entity.LogicalId})`, target);
      });
    });

/**
 * Build the impl Effect of a per-operation binding on a {@link Queue}: the
 * callable injects `namespaceName` and `queueName`, and the deploy-time half
 * assigns `roles` on the queue.
 */
export const makeQueueOperationBinding = makeOperationBinding<Queue, QueueTarget>(queueTarget);

/**
 * Build the impl Effect of a per-operation send binding on a {@link Queue}
 * or {@link Topic}: the callable injects `namespaceName` and `entityPath`.
 */
export const makeEntityOperationBinding = makeOperationBinding<Queue | Topic, EntityTarget>(
  entityTarget,
);

/**
 * Build the impl Effect of a per-operation binding on a topic
 * {@link Subscription}: the callable injects `namespaceName`, `topicName`
 * and `subscriptionName`.
 */
export const makeSubscriptionOperationBinding = makeOperationBinding<
  Subscription,
  SubscriptionTarget
>(subscriptionTarget);

const encodeBody = (body: string | object) =>
  typeof body === "string" ? body : JSON.stringify(body);

const contentTypeOf = (body: string | object, options?: ServiceBusSendOptions) =>
  options?.contentType ?? (typeof body === "string" ? "text/plain" : "application/json");

/** `90061` seconds → `1.01:01:01`, the TimeSpan a batch message's TTL takes. */
const toTimeSpan = (seconds: number) => {
  const whole = Math.floor(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  return `${days}.${pad(hours)}:${pad(minutes)}:${pad(whole % 60)}`;
};

/** The per-operation callables the Service Bus clients are built from. */
export const makeServiceBusOperations = Effect.gen(function* () {
  const send = yield* AzureBindings.withCredentials(messaging.SendMessage);
  const sendBatch = yield* AzureBindings.withCredentials(messaging.SendMessageBatch);
  const peekLock = yield* AzureBindings.withCredentials(messaging.PeekLockMessage);
  const receiveAndDelete = yield* AzureBindings.withCredentials(messaging.ReceiveAndDeleteMessage);
  const complete = yield* AzureBindings.withCredentials(messaging.CompleteMessage);
  const unlock = yield* AzureBindings.withCredentials(messaging.UnlockMessage);
  const renew = yield* AzureBindings.withCredentials(messaging.RenewMessageLock);
  const peekLockSub = yield* AzureBindings.withCredentials(messaging.PeekLockSubscriptionMessage);
  const receiveAndDeleteSub = yield* AzureBindings.withCredentials(
    messaging.ReceiveAndDeleteSubscriptionMessage,
  );
  const completeSub = yield* AzureBindings.withCredentials(messaging.CompleteSubscriptionMessage);
  const unlockSub = yield* AzureBindings.withCredentials(messaging.UnlockSubscriptionMessage);
  const renewSub = yield* AzureBindings.withCredentials(messaging.RenewSubscriptionMessageLock);
  return {
    send: onEntity(send),
    sendBatch: onEntity(sendBatch),
    queue: {
      peekLock: onQueue(peekLock),
      receiveAndDelete: onQueue(receiveAndDelete),
      complete: onQueue(complete),
      unlock: onQueue(unlock),
      renew: onQueue(renew),
    },
    subscription: {
      peekLock: onSubscription(peekLockSub),
      receiveAndDelete: onSubscription(receiveAndDeleteSub),
      complete: onSubscription(completeSub),
      unlock: onSubscription(unlockSub),
      renew: onSubscription(renewSub),
    },
  };
});

export type ServiceBusOperations = Effect.Success<typeof makeServiceBusOperations>;

/** `send` and `sendBatch` over Send Message and Send Message Batch. */
export const makeWriteServiceBusClient =
  (ops: ServiceBusOperations) =>
  (label: string, target: Target<EntityTarget>): WriteServiceBusClient => {
    const send = ops.send(`${label}.send`, target);
    const sendBatch = ops.sendBatch(`${label}.sendBatch`, target);
    return {
      send: (body: string | object, options?: ServiceBusSendOptions) =>
        send({
          body: encodeBody(body),
          contentType: contentTypeOf(body, options),
          brokerProperties: {
            messageId: options?.messageId,
            sessionId: options?.sessionId,
            correlationId: options?.correlationId,
            label: options?.label,
            timeToLive: options?.timeToLiveSeconds,
          },
          customProperties: options?.properties,
        }).pipe(Effect.asVoid),
      sendBatch: (messages: ReadonlyArray<ServiceBusBatchEntry>) =>
        messages.length === 0
          ? Effect.void
          : sendBatch({
              messages: messages.map(({ body, options }) => ({
                body: encodeBody(body),
                brokerProperties: {
                  contentType: contentTypeOf(body, options),
                  messageId: options?.messageId,
                  sessionId: options?.sessionId,
                  correlationId: options?.correlationId,
                  label: options?.label,
                  timeToLiveTimeSpan:
                    options?.timeToLiveSeconds === undefined
                      ? undefined
                      : toTimeSpan(options.timeToLiveSeconds),
                },
                userProperties: options?.properties,
              })),
            }).pipe(Effect.asVoid),
    };
  };

/** `send` only, as {@link SendServiceBusQueueClient}. */
export const makeSendServiceBusClient =
  (ops: ServiceBusOperations) =>
  (label: string, target: Target<EntityTarget>): SendServiceBusQueueClient => ({
    send: makeWriteServiceBusClient(ops)(label, target).send,
  });

type Received = {
  body?: Uint8Array;
  contentType?: string;
  brokerProperties?: messaging.BrokerProperties;
  headers?: messaging.HeaderMap;
};

const toMessage = (res: Received & { body: Uint8Array }): ServiceBusReceivedMessage => ({
  body: res.body,
  text: new TextDecoder().decode(res.body),
  contentType: res.contentType,
  messageId: res.brokerProperties?.messageId,
  deliveryCount: res.brokerProperties?.deliveryCount,
  enqueuedTimeUtc: res.brokerProperties?.enqueuedTimeUtc,
  brokerProperties: res.brokerProperties ?? {},
  headers: res.headers ?? {},
});

/**
 * The lock URI's message reference (`.../messages/{reference}/{lockToken}`).
 * Read from `Location` because sequence numbers are 64-bit and lose
 * precision as JSON numbers.
 */
const lockReference = (location: string | undefined, bp: messaging.BrokerProperties) => {
  const segments = location === undefined ? [] : new URL(location).pathname.split("/");
  return segments.at(-2) ?? bp.messageId ?? String(bp.sequenceNumber ?? "");
};

const toLocked = (
  res: Received & { body: Uint8Array; location?: string },
): ServiceBusLockedMessage => {
  const bp = res.brokerProperties ?? {};
  return {
    ...toMessage(res),
    lockReference: lockReference(res.location, bp),
    lockToken: bp.lockToken ?? "",
    lockedUntilUtc: bp.lockedUntilUtc,
  };
};

/** A lock URI's message reference and lock token, as the settle operations take them. */
type LockRequest = { messageId: string; lockToken: string };

/** The receive and settle callables of one queue or subscription. */
interface ReceiveOperations {
  peekLock: (request?: {
    timeout?: number;
  }) => Effect.Effect<messaging.PeekLockMessageResponse, messaging.PeekLockMessageError>;
  receiveAndDelete: (request?: {
    timeout?: number;
  }) => Effect.Effect<
    messaging.ReceiveAndDeleteMessageResponse,
    messaging.ReceiveAndDeleteMessageError
  >;
  complete: (request?: LockRequest) => Effect.Effect<unknown, messaging.CompleteMessageError>;
  unlock: (request?: LockRequest) => Effect.Effect<unknown, messaging.UnlockMessageError>;
  renew: (request?: LockRequest) => Effect.Effect<unknown, messaging.RenewMessageLockError>;
}

const settle = (message: Pick<ServiceBusLockedMessage, "lockReference" | "lockToken">) => ({
  messageId: message.lockReference,
  lockToken: message.lockToken,
});

const makeReceiveClient = (ops: ReceiveOperations): ReceiveServiceBusClient => ({
  receive: (options?: ServiceBusReceiveOptions) =>
    ops
      .peekLock({ timeout: options?.timeoutSeconds })
      .pipe(
        Effect.map((res) =>
          res.body === undefined ? undefined : toLocked({ ...res, body: res.body }),
        ),
      ),
  receiveAndDelete: (options?: ServiceBusReceiveOptions) =>
    ops
      .receiveAndDelete({ timeout: options?.timeoutSeconds })
      .pipe(
        Effect.map((res) =>
          res.body === undefined ? undefined : toMessage({ ...res, body: res.body }),
        ),
      ),
  complete: (message) => ops.complete(settle(message)).pipe(Effect.asVoid),
  abandon: (message) => ops.unlock(settle(message)).pipe(Effect.asVoid),
  renewLock: (message) => ops.renew(settle(message)).pipe(Effect.asVoid),
});

/** Peek-lock, receive-and-delete, and settle the messages of a queue. */
export const makeReceiveServiceBusQueueClient =
  (ops: ServiceBusOperations) =>
  (label: string, target: Target<QueueTarget>): ReceiveServiceBusClient =>
    makeReceiveClient({
      peekLock: ops.queue.peekLock(`${label}.receive`, target),
      receiveAndDelete: ops.queue.receiveAndDelete(`${label}.receiveAndDelete`, target),
      complete: ops.queue.complete(`${label}.complete`, target),
      unlock: ops.queue.unlock(`${label}.abandon`, target),
      renew: ops.queue.renew(`${label}.renewLock`, target),
    });

/** Peek-lock, receive-and-delete, and settle the messages of a topic subscription. */
export const makeReceiveServiceBusSubscriptionClient =
  (ops: ServiceBusOperations) =>
  (label: string, target: Target<SubscriptionTarget>): ReceiveServiceBusClient =>
    makeReceiveClient({
      peekLock: ops.subscription.peekLock(`${label}.receive`, target),
      receiveAndDelete: ops.subscription.receiveAndDelete(`${label}.receiveAndDelete`, target),
      complete: ops.subscription.complete(`${label}.complete`, target),
      unlock: ops.subscription.unlock(`${label}.abandon`, target),
      renew: ops.subscription.renew(`${label}.renewLock`, target),
    });

/**
 * Build a Service Bus binding on a queue, topic or subscription that
 * assigns `roles` on the entity and returns the client `makeClient` builds
 * from the per-operation callables.
 */
const makeServiceBusBinding =
  <R extends ServiceBusEntity, T extends object>(
    resolveTarget: (entity: R) => Effect.Effect<Target<T>>,
  ) =>
  <Client>(options: {
    /** Fully-qualified binding tag, e.g. `Azure.ServiceBus.QueueRead`. */
    tag: string;
    roles: ReadonlyArray<string>;
    makeClient: (ops: ServiceBusOperations) => (label: string, target: Target<T>) => Client;
  }) =>
    Effect.gen(function* () {
      const grantOn = yield* GrantOn;
      const ops = yield* makeServiceBusOperations;
      const makeClient = options.makeClient(ops);
      return Effect.fn(function* (entity: R) {
        yield* grantOn(options.tag, entity, options.roles);
        const target = yield* resolveTarget(entity);
        return makeClient(`${options.tag}(${entity.LogicalId})`, target);
      });
    });

/** A client binding on a {@link Queue} that receives and settles messages. */
export const makeQueueReceiveBinding = makeServiceBusBinding<Queue, QueueTarget>(queueTarget);

/** A client binding on a {@link Queue} or {@link Topic} that sends messages. */
export const makeEntitySendBinding = makeServiceBusBinding<Queue | Topic, EntityTarget>(
  entityTarget,
);

/** A client binding on a topic {@link Subscription}. */
export const makeSubscriptionReceiveBinding = makeServiceBusBinding<
  Subscription,
  SubscriptionTarget
>(subscriptionTarget);

/**
 * A client binding on a {@link Queue} that both sends and receives: the
 * client gets the queue's `entityPath` and `queueName` targets.
 */
export const makeQueueReadWriteBinding = <Client>(options: {
  tag: string;
  roles: ReadonlyArray<string>;
  makeClient: (
    ops: ServiceBusOperations,
  ) => (label: string, send: Target<EntityTarget>, receive: Target<QueueTarget>) => Client;
}) =>
  Effect.gen(function* () {
    const grantOn = yield* GrantOn;
    const ops = yield* makeServiceBusOperations;
    const makeClient = options.makeClient(ops);
    return Effect.fn(function* (queue: Queue) {
      yield* grantOn(options.tag, queue, options.roles);
      const send = yield* entityTarget(queue);
      const receive = yield* queueTarget(queue);
      return makeClient(`${options.tag}(${queue.LogicalId})`, send, receive);
    });
  });
