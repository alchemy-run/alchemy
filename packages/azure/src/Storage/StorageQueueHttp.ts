import * as queues from "@distilled.cloud/azure/storage-queue";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { RoleDefinition, type RolePermission } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Queue } from "./Queue.ts";
import type { ReadStorageQueueClient, StorageQueueProperties } from "./QueueRead.ts";
import type { ReadWriteStorageQueueClient } from "./QueueReadWrite.ts";
import type {
  PeekStorageQueueClient,
  ReceiveStorageQueueClient,
  StorageQueueMessage,
  StorageQueuePeekedMessage,
  StorageQueueReceiveOptions,
} from "./QueueReceive.ts";
import type { SendStorageQueueClient, StorageQueueSendOptions } from "./QueueSend.ts";
import type { StorageQueueUpdateOptions, WriteStorageQueueClient } from "./QueueWrite.ts";
import type { StorageAccount } from "./StorageAccount.ts";

/**
 * Shared scaffolding for the storage queue bindings: resolves the distilled
 * `storage-queue` operations once when the layer is built and, at deploy
 * time, assigns the binding's role on the bound queue (or account).
 *
 * NOT exported from `index.ts`.
 */

/**
 * The role a queue binding needs: a built-in role whose data actions match
 * the operation exactly, or an `Azure.Authorization.RoleDefinition` with
 * exactly the operation's permissions when every built-in role grants more.
 * A custom role is created once per stack under `customRole` (its logical
 * ID) and shared by every host that binds it.
 */
export type QueueGrant =
  | { readonly builtInRole: string }
  | {
      readonly customRole: string;
      readonly description: string;
      readonly permissions: RolePermission;
    };

const QUEUE_SERVICE = "Microsoft.Storage/storageAccounts/queueServices";
const QUEUES = `${QUEUE_SERVICE}/queues`;
const MESSAGES = `${QUEUES}/messages`;

/**
 * The least-privilege role of every queue binding. Data actions per
 * operation: https://learn.microsoft.com/rest/api/storageservices/authorize-with-azure-active-directory#permissions-for-calling-data-operations
 */
export const QueueGrants = {
  /** Put Message: `messages/add/action` (Storage Queue Data Message Sender). */
  send: { builtInRole: BuiltInRole.StorageQueueDataMessageSender },
  /** Peek Messages: `messages/read` (Storage Queue Data Reader, which adds `queues/read`). */
  peek: { builtInRole: BuiltInRole.StorageQueueDataReader },
  /** Get, Peek, and Delete Messages: Storage Queue Data Message Processor. */
  receive: { builtInRole: BuiltInRole.StorageQueueDataMessageProcessor },
  /** Get Messages and Delete Message: `messages/process/action` only. */
  process: {
    customRole: "AzureStorageQueueProcessRole",
    description: "Dequeue and delete Azure Storage queue messages.",
    permissions: { dataActions: [`${MESSAGES}/process/action`] },
  },
  /** Update Message: `messages/write` only. */
  update: {
    customRole: "AzureStorageQueueUpdateRole",
    description: "Update Azure Storage queue messages.",
    permissions: { dataActions: [`${MESSAGES}/write`] },
  },
  /** Clear Messages: `messages/delete` only. */
  clear: {
    customRole: "AzureStorageQueueClearRole",
    description: "Clear Azure Storage queue messages.",
    permissions: { dataActions: [`${MESSAGES}/delete`] },
  },
  /** Get Queue Metadata and List Queues: `queues/read` only. */
  readQueue: {
    customRole: "AzureStorageQueueReadRole",
    description: "Read Azure Storage queue properties and list queues.",
    permissions: { actions: [`${QUEUES}/read`] },
  },
  /** Get Queue ACL: `queues/getAcl/action` only. */
  getAcl: {
    customRole: "AzureStorageQueueGetAclRole",
    description: "Read Azure Storage queue stored access policies.",
    permissions: { actions: [`${QUEUES}/getAcl/action`] },
  },
  /** Set Queue ACL: `queues/setAcl/action` only. */
  setAcl: {
    customRole: "AzureStorageQueueSetAclRole",
    description: "Set Azure Storage queue stored access policies.",
    permissions: { actions: [`${QUEUES}/setAcl/action`] },
  },
  /** Get Queue Service Properties and Stats: `queueServices/read` only. */
  readService: {
    customRole: "AzureStorageQueueServiceReadRole",
    description: "Read Azure Storage queue service properties and statistics.",
    permissions: { actions: [`${QUEUE_SERVICE}/read`] },
  },
  /**
   * Put, Update, Delete, and Clear: `messages/write`, `messages/delete`, and
   * `messages/process/action` (Delete Message is denied without it, despite
   * the docs listing `messages/delete` as an alternative).
   */
  write: {
    customRole: "AzureStorageQueueWriteRole",
    description: "Send, update, delete, and clear Azure Storage queue messages.",
    permissions: {
      dataActions: [`${MESSAGES}/write`, `${MESSAGES}/delete`, `${MESSAGES}/process/action`],
    },
  },
  /** Everything `read`, `write`, and `receive` need; no queue create/delete. */
  readWrite: {
    customRole: "AzureStorageQueueReadWriteRole",
    description: "Peek, receive, send, update, delete, and clear Azure Storage queue messages.",
    permissions: {
      actions: [`${QUEUES}/read`],
      dataActions: [
        `${MESSAGES}/read`,
        `${MESSAGES}/write`,
        `${MESSAGES}/delete`,
        `${MESSAGES}/process/action`,
      ],
    },
  },
} satisfies Record<string, QueueGrant>;

type Grant = (
  tag: string,
  resource: Queue | StorageAccount,
  scope: Input<string>,
  grant: QueueGrant,
) => Effect.Effect<void>;

const GrantOn = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // A host bundle never binds, so it drops the role-definition resource.
  if (globalThis.__ALCHEMY_RUNTIME__) {
    const noop: Grant = () => Effect.void;
    return noop;
  }
  const AzureRoleDefinition = yield* RoleDefinition;
  const grantOn: Grant = Effect.fn(function* (
    tag: string,
    resource: Queue | StorageAccount,
    scope: Input<string>,
    grant: QueueGrant,
  ) {
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      let roleDefinitionId: Input<string>;
      if ("builtInRole" in grant) {
        roleDefinitionId = grant.builtInRole;
      } else {
        const role = yield* AzureRoleDefinition(grant.customRole, {
          description: grant.description,
          permissions: [grant.permissions],
        });
        roleDefinitionId = role.roleDefinitionId;
      }
      yield* bind`${tag}(${resource})`({
        roleAssignments: [{ roleDefinitionId, scope }],
      });
    }
  });
  return grantOn;
});

/** Where a queue lives, resolved per call at runtime. */
export interface QueueAddress {
  readonly tag: string;
  /** `https://{account}.queue.core.windows.net` */
  readonly url: Effect.Effect<string>;
  readonly queueName: Effect.Effect<string>;
}

/** Where a storage account's queue service lives, resolved per call at runtime. */
export interface QueueServiceAddress {
  readonly tag: string;
  /** `https://{account}.queue.core.windows.net`, or the `-secondary` endpoint. */
  readonly url: Effect.Effect<string>;
}

type QueueTarget = { url: string; queueName: string };

/** A distilled operation resolved with the host's credentials. */
type Operation<I, A, E> = Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;

/** Bind `op` to a queue: the callable injects the queue's `url` and `queueName`. */
const onQueue =
  <I extends QueueTarget, A, E>(op: (input: I) => Effect.Effect<A, E>) =>
  (address: QueueAddress) =>
    Effect.fn(address.tag)(function* (request?: Omit<I, keyof QueueTarget>) {
      const url = yield* address.url;
      const queueName = yield* address.queueName;
      // `Omit<I, K> & Pick<I, K>` is `I`; TS cannot prove it for a generic `I`.
      return yield* op({ ...request, url, queueName } as I);
    });

/** Bind `op` to a queue service: the callable injects the account's `url`. */
const onService =
  <I extends { url: string }, A, E>(op: (input: I) => Effect.Effect<A, E>) =>
  (address: QueueServiceAddress) =>
    Effect.fn(address.tag)(function* (request?: Omit<I, "url">) {
      const url = yield* address.url;
      // `Omit<I, "url"> & Pick<I, "url">` is `I`; TS cannot prove it for a generic `I`.
      return yield* op({ ...request, url } as I);
    });

/** The address of `queue`, labelled `<tag>(<queue>)`. */
const queueAddress = (tag: string, queue: Queue) =>
  Effect.gen(function* () {
    const url = yield* Output.interpolate`https://${queue.storageAccount}.queue.core.windows.net`;
    const queueName = yield* queue.queueName;
    return { tag: `${tag}(${queue.LogicalId})`, url, queueName } satisfies QueueAddress;
  });

/**
 * Build the impl Effect of a queue-scoped per-operation binding: the
 * callable injects the bound {@link Queue}'s `url` and `queueName`, and the
 * deploy-time half assigns `grant` on the queue.
 */
export const makeQueueOperationBinding = <I extends QueueTarget, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.SendQueueMessage`. */
  tag: string;
  /** The distilled `storage-queue` operation. */
  operation: Operation<I, A, E>;
  grant: QueueGrant;
}) =>
  Effect.gen(function* () {
    const grantOn = yield* GrantOn;
    const op = yield* AzureBindings.withCredentials(options.operation);
    const bound = onQueue(op);
    return Effect.fn(function* (queue: Queue) {
      yield* grantOn(options.tag, queue, queue.queueId, options.grant);
      const address = yield* queueAddress(options.tag, queue);
      return bound(address);
    });
  });

/**
 * Build the impl Effect of an account-scoped per-operation binding: the
 * callable injects the bound {@link StorageAccount}'s queue endpoint (the
 * `-secondary` one when `secondary`), and the deploy-time half assigns
 * `grant` on the account.
 */
export const makeQueueServiceOperationBinding = <I extends { url: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.ListQueues`. */
  tag: string;
  /** The distilled `storage-queue` operation. */
  operation: Operation<I, A, E>;
  grant: QueueGrant;
  /** Call the read-access geo-redundant secondary endpoint. */
  secondary?: boolean;
}) =>
  Effect.gen(function* () {
    const grantOn = yield* GrantOn;
    const op = yield* AzureBindings.withCredentials(options.operation);
    const bound = onService(op);
    const host = options.secondary
      ? "-secondary.queue.core.windows.net"
      : ".queue.core.windows.net";
    return Effect.fn(function* (account: StorageAccount) {
      yield* grantOn(options.tag, account, account.storageAccountId, options.grant);
      const url = yield* Output.interpolate`https://${account.storageAccountName}${host}`;
      return bound({ tag: `${options.tag}(${account.LogicalId})`, url });
    });
  });

/** The per-operation callables a queue client is built from. */
export const makeQueueOperations = Effect.gen(function* () {
  const enqueue = yield* AzureBindings.withCredentials(queues.MessagesEnqueue);
  const dequeue = yield* AzureBindings.withCredentials(queues.MessagesDequeue);
  const peek = yield* AzureBindings.withCredentials(queues.MessagesPeek);
  const update = yield* AzureBindings.withCredentials(queues.UpdateMessageId);
  const remove = yield* AzureBindings.withCredentials(queues.DeleteMessageId);
  const clear = yield* AzureBindings.withCredentials(queues.ClearMessage);
  const getProperties = yield* AzureBindings.withCredentials(queues.GetQueueProperties);
  return {
    enqueue: onQueue(enqueue),
    dequeue: onQueue(dequeue),
    peek: onQueue(peek),
    update: onQueue(update),
    remove: onQueue(remove),
    clear: onQueue(clear),
    getProperties: onQueue(getProperties),
  };
});

export type QueueOperations = Effect.Success<typeof makeQueueOperations>;

const toMessage = (message: queues.DequeuedMessageItem): StorageQueueMessage => ({
  messageId: message.MessageId,
  popReceipt: message.PopReceipt,
  text: message.MessageText,
  dequeueCount: message.DequeueCount,
  insertionTime: message.InsertionTime,
});

const toPeeked = (message: queues.PeekedMessageItem): StorageQueuePeekedMessage => ({
  messageId: message.MessageId,
  text: message.MessageText,
  dequeueCount: message.DequeueCount,
  insertionTime: message.InsertionTime,
});

/** `send` over Put Message. */
export const makeSendStorageQueueClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): SendStorageQueueClient => {
    const enqueue = ops.enqueue(address);
    return {
      send: Effect.fn(`${address.tag}.send`)(function* (
        message: string,
        options?: StorageQueueSendOptions,
      ) {
        const [sent] = yield* enqueue({
          MessageText: message,
          visibilitytimeout: options?.visibilityTimeoutSeconds,
          messagettl: options?.timeToLiveSeconds,
        });
        return {
          messageId: sent?.MessageId,
          popReceipt: sent?.PopReceipt,
          insertionTime: sent?.InsertionTime,
        };
      }),
    };
  };

/** `peek` over Peek Messages. */
export const makePeekStorageQueueClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): PeekStorageQueueClient => {
    const peek = ops.peek(address);
    return {
      peek: Effect.fn(`${address.tag}.peek`)(function* (maxMessages?: number) {
        const messages = yield* peek({ numofmessages: maxMessages ?? 1 });
        return messages.map(toPeeked);
      }),
    };
  };

/** `getProperties` over Get Queue Metadata. */
export const makeQueuePropertiesClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): Pick<ReadStorageQueueClient, "getProperties"> => {
    const getProperties = ops.getProperties(address);
    return {
      getProperties: Effect.fn(`${address.tag}.getProperties`)(function* () {
        const res = yield* getProperties();
        return {
          approximateMessageCount: res.xMsApproximateMessagesCount ?? 0,
          metadata: Object.fromEntries(
            Object.entries(res.metadata ?? {}).flatMap(([k, v]) =>
              v === undefined ? [] : [[k, v] as const],
            ),
          ),
        } satisfies StorageQueueProperties;
      }),
    };
  };

/** `delete` over Delete Message; a message that is already gone succeeds. */
export const makeDeleteStorageQueueClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): Pick<WriteStorageQueueClient, "delete"> => {
    const remove = ops.remove(address);
    return {
      delete: Effect.fn(`${address.tag}.delete`)(function* (
        message: Pick<StorageQueueMessage, "messageId" | "popReceipt">,
      ) {
        yield* remove({ messageid: message.messageId, popreceipt: message.popReceipt }).pipe(
          Effect.catchTag("MessageNotFound", () => Effect.void),
        );
      }),
    };
  };

/** `update` over Update Message and `clear` over Clear Messages. */
export const makeUpdateClearStorageQueueClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): Pick<WriteStorageQueueClient, "update" | "clear"> => {
    const update = ops.update(address);
    const clear = ops.clear(address);
    return {
      update: Effect.fn(`${address.tag}.update`)(function* (
        message: Pick<StorageQueueMessage, "messageId" | "popReceipt">,
        options: StorageQueueUpdateOptions,
      ) {
        const res = yield* update({
          messageid: message.messageId,
          popreceipt: message.popReceipt,
          MessageText: options.text,
          visibilitytimeout: options.visibilityTimeoutSeconds ?? 0,
        });
        return {
          popReceipt: res.xMsPopreceipt ?? "",
          timeNextVisible: res.xMsTimeNextVisible,
        };
      }),
      clear: Effect.fn(`${address.tag}.clear`)(function* () {
        yield* clear();
      }),
    };
  };

/** `receive`, `delete`, and `peek` (what Message Processor grants). */
export const makeReceiveStorageQueueClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): ReceiveStorageQueueClient => {
    const dequeue = ops.dequeue(address);
    return {
      receive: Effect.fn(`${address.tag}.receive`)(function* (
        options?: StorageQueueReceiveOptions,
      ) {
        const messages = yield* dequeue({
          numofmessages: options?.maxMessages ?? 1,
          visibilitytimeout: options?.visibilityTimeoutSeconds,
        });
        return messages.map(toMessage);
      }),
      ...makeDeleteStorageQueueClient(ops)(address),
      ...makePeekStorageQueueClient(ops)(address),
    };
  };

/** `peek` and `getProperties` (what Storage Queue Data Reader grants). */
export const makeReadStorageQueueClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): ReadStorageQueueClient => ({
    ...makePeekStorageQueueClient(ops)(address),
    ...makeQueuePropertiesClient(ops)(address),
  });

/** `send`, `update`, `delete`, and `clear`. */
export const makeWriteStorageQueueClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): WriteStorageQueueClient => ({
    ...makeSendStorageQueueClient(ops)(address),
    ...makeUpdateClearStorageQueueClient(ops)(address),
    ...makeDeleteStorageQueueClient(ops)(address),
  });

/** Every queue message operation. */
export const makeReadWriteStorageQueueClient =
  (ops: QueueOperations) =>
  (address: QueueAddress): ReadWriteStorageQueueClient => ({
    ...makeReadStorageQueueClient(ops)(address),
    ...makeWriteStorageQueueClient(ops)(address),
    ...makeReceiveStorageQueueClient(ops)(address),
  });

/**
 * Build a storage queue binding that assigns `grant` on the queue and
 * returns the client `makeClient` builds from the per-operation callables.
 */
export const makeStorageQueueBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Storage.QueueSend`. */
  tag: string;
  grant: QueueGrant;
  makeClient: (ops: QueueOperations) => (address: QueueAddress) => Client;
}) =>
  Effect.gen(function* () {
    const grantOn = yield* GrantOn;
    const ops = yield* makeQueueOperations;
    const makeClient = options.makeClient(ops);
    return Effect.fn(function* (queue: Queue) {
      yield* grantOn(options.tag, queue, queue.queueId, options.grant);
      const address = yield* queueAddress(options.tag, queue);
      return makeClient(address);
    });
  });
