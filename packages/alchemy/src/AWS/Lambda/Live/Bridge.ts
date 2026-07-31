/**
 * Live Lambda bridge — the code actually deployed to AWS Lambda when a
 * Function runs under `alchemy dev`.
 *
 * Each invocation is forwarded over AWS AppSync Events to the developer's
 * machine, executed there against the locally-built handler, and the result
 * is returned as this function's response. One bridge sandbox = one
 * `workerId` (the tail of the log stream name, unique per concurrent
 * execution environment), mirroring SST's live bridge:
 *
 * 1. On first invoke, subscribe to `{prefix}/{workerId}/in` and publish an
 *    `init` message (function id + sandbox environment, including the
 *    execution role's credentials) to `{prefix}/in`.
 * 2. Per invocation, publish a `next` message and wait. The dev machine
 *    replies `ping` immediately (extending the wait from 16s to the
 *    invocation deadline), then `response` or `error`.
 * 3. `reboot` means the dev machine doesn't know this worker (CLI
 *    restarted) — re-publish `init`.
 * 4. No `ping` within 16s → the dev machine is offline; fail the invocation.
 *
 * This file is bundled standalone (plus its local imports) at deploy time —
 * it must stay dependency-free apart from node builtins.
 */
import type * as lambda from "aws-lambda";
import { AppSyncEventsClient } from "./AppSyncEvents.ts";
import {
  channelPrefix,
  devChannel,
  encodePackets,
  ENV_BLACKLIST,
  PacketAssembler,
  workerChannel,
  type ErrorBody,
  type InitBody,
  type Message,
  type NextBody,
  type Packet,
  type ResponseBody,
} from "./Protocol.ts";

const OFFLINE_TIMEOUT_MS = 16_000;

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`live lambda bridge: missing environment variable ${name}`);
  }
  return value;
};

const logStreamName = process.env.AWS_LAMBDA_LOG_STREAM_NAME ?? "";
const workerId =
  logStreamName.length >= 32
    ? logStreamName.slice(-32)
    : crypto.randomUUID().replace(/-/g, "");

let client: AppSyncEventsClient | undefined;
let session: Promise<void> | undefined;
let currentWait:
  | { requestId: string; onMessage: (message: Message) => void }
  | undefined;

const getClient = (): AppSyncEventsClient => {
  client ??= new AppSyncEventsClient({
    httpEndpoint: env("ALCHEMY_LIVE_APPSYNC_HTTP"),
    realtimeEndpoint: env("ALCHEMY_LIVE_APPSYNC_REALTIME"),
    region: env("AWS_REGION"),
    getCredentials: async () => ({
      accessKeyId: env("AWS_ACCESS_KEY_ID"),
      secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
      sessionToken: process.env.AWS_SESSION_TOKEN,
    }),
    log: (message) => console.log(message),
  });
  return client;
};

const prefix = () =>
  channelPrefix("alchemy", env("ALCHEMY_STACK_NAME"), env("ALCHEMY_STAGE"));

const sendInit = async () => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !ENV_BLACKLIST.has(key)) {
      environment[key] = value;
    }
  }
  const body: InitBody = {
    functionId: env("ALCHEMY_LIVE_FUNCTION_ID"),
    workerId,
    environment,
  };
  for (const packet of encodePackets(
    "init",
    workerId,
    crypto.randomUUID(),
    body,
  )) {
    await getClient().publish(devChannel(prefix()), packet);
  }
};

const assembler = new PacketAssembler();

const onChannelEvent = (raw: string) => {
  let packet: Packet;
  try {
    packet = JSON.parse(raw);
  } catch {
    return;
  }
  const message = assembler.push(packet);
  if (!message) return;
  if (message.type === "reboot") {
    // Dev machine restarted and doesn't know this worker — re-introduce
    // ourselves (fire and forget; the pending invocation keeps waiting).
    sendInit().catch((error) => console.error("re-init failed", error));
    return;
  }
  currentWait?.onMessage(message);
};

/**
 * Connect + subscribe + announce, memoized per sandbox. The memo is cleared
 * on failure so a transient AppSync outage doesn't poison the sandbox, and
 * `ensureHealthy` revives connections that died while the sandbox was frozen.
 */
const ensureSession = async () => {
  await getClient().ensureHealthy();
  session ??= (async () => {
    await getClient().subscribe(
      workerChannel(prefix(), workerId),
      onChannelEvent,
    );
    await sendInit();
  })().catch((error) => {
    session = undefined;
    throw error;
  });
  await session;
};

export const handler = async (
  event: unknown,
  context: lambda.Context,
): Promise<unknown> => {
  await ensureSession();
  const requestId = context.awsRequestId;
  const deadlineMs = Date.now() + context.getRemainingTimeInMillis();

  const body: NextBody = {
    functionId: env("ALCHEMY_LIVE_FUNCTION_ID"),
    workerId,
    requestId,
    event,
    context: {
      functionName: context.functionName,
      functionVersion: context.functionVersion,
      invokedFunctionArn: context.invokedFunctionArn,
      memoryLimitInMB: context.memoryLimitInMB,
      awsRequestId: context.awsRequestId,
      logGroupName: context.logGroupName,
      logStreamName: context.logStreamName,
      identity: context.identity,
      clientContext: context.clientContext,
      deadlineMs,
    },
  };

  const result = new Promise<unknown>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const armTimer = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        currentWait = undefined;
        reject(
          new Error(
            `alchemy dev is not running (worker: ${workerId}). Start it with \`alchemy dev\`.`,
          ),
        );
      }, ms);
    };
    armTimer(OFFLINE_TIMEOUT_MS);
    currentWait = {
      requestId,
      onMessage: (message) => {
        if (message.id !== requestId) return;
        switch (message.type) {
          case "ping":
            // Dev machine acknowledged — wait until just before our own
            // deadline for the real response.
            armTimer(Math.max(deadlineMs - Date.now() - 500, 1_000));
            break;
          case "response": {
            clearTimeout(timer);
            currentWait = undefined;
            const { result } = JSON.parse(message.body) as ResponseBody;
            resolve(result);
            break;
          }
          case "error": {
            clearTimeout(timer);
            currentWait = undefined;
            const errorBody = JSON.parse(message.body) as ErrorBody;
            const error = new Error(errorBody.errorMessage);
            error.name = errorBody.errorType;
            if (errorBody.trace) {
              error.stack = errorBody.trace.join("\n");
            }
            reject(error);
            break;
          }
        }
      },
    };
  });

  for (const packet of encodePackets("next", workerId, requestId, body)) {
    await getClient().publish(devChannel(prefix()), packet);
  }

  return result;
};
