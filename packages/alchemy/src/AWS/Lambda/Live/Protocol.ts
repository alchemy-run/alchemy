/**
 * Wire protocol for Live Lambda.
 *
 * A deployed "bridge" Lambda forwards invocations to the developer's machine
 * over AWS AppSync Events and waits for the response. Messages are JSON
 * "packets" chunked to fit under AppSync's per-event payload limit, mirroring
 * SST v3's live bridge framing.
 *
 * This module is plain TypeScript (no Effect) because it is bundled into the
 * bridge Lambda and the local handler child process as-is.
 */

/**
 * One AppSync event. Large messages are split into multiple packets sharing
 * an `id`; `index` orders them and `final` marks the last one.
 */
export interface Packet {
  type: MessageType;
  /** Sender: a bridge sandbox's workerId, or {@link DEV_SOURCE} for the CLI. */
  source: string;
  /** Correlates chunks and request/response pairs (the Lambda requestId). */
  id: string;
  index: number;
  /** Base64 chunk of the JSON body. */
  data: string;
  final: boolean;
}

export type MessageType =
  /** Bridge sandbox announces itself + its environment to the dev machine. */
  | "init"
  /** Dev machine acknowledges an invocation, extending the bridge's wait. */
  | "ping"
  /** Bridge forwards an invocation to the dev machine. */
  | "next"
  /** Dev machine returns the handler result. */
  | "response"
  /** Dev machine returns a handler (or init) error. */
  | "error"
  /** Dev machine doesn't recognize the worker; bridge must re-`init`. */
  | "reboot";

/** `source` used by the dev-machine side. */
export const DEV_SOURCE = "dev";

export interface InitBody {
  functionId: string;
  workerId: string;
  /** The sandbox environment (minus {@link ENV_BLACKLIST}), including the execution role's credentials. */
  environment: Record<string, string>;
}

export interface NextBody {
  functionId: string;
  workerId: string;
  requestId: string;
  /** Serialized subset of the Lambda context to rebuild on the local side. */
  context: SerializedContext;
  event: unknown;
}

export interface SerializedContext {
  functionName: string;
  functionVersion: string;
  invokedFunctionArn: string;
  memoryLimitInMB: string;
  awsRequestId: string;
  logGroupName: string;
  logStreamName: string;
  identity?: unknown;
  clientContext?: unknown;
  /** Epoch millis after which the invocation is dead. */
  deadlineMs: number;
}

export interface ResponseBody {
  result: unknown;
}

export interface ErrorBody {
  errorType: string;
  errorMessage: string;
  trace?: string[];
}

/**
 * Raw bytes per chunk before base64. AppSync Events caps each event around
 * 240KB; 128KB of raw data base64-encodes to ~171KB, leaving headroom for the
 * packet envelope.
 */
export const CHUNK_SIZE = 128 * 1024;

/** Channel the dev machine subscribes to: bridges publish `init`/`next` here. */
export const devChannel = (prefix: string) => `${prefix}/in`;

/** Channel a bridge sandbox subscribes to: the dev machine publishes here. */
export const workerChannel = (prefix: string, workerId: string) =>
  `${prefix}/${sanitizeSegment(workerId)}/in`;

const hashSegment = (segment: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < segment.length; index++) {
    hash = Math.imul(hash ^ segment.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * AppSync channel segments are 1-50 alphanumeric-or-dash characters. Preserve
 * a readable prefix and append a stable hash when truncation is necessary so
 * long stack names cannot collide.
 */
const sanitizeSegment = (segment: string) => {
  const sanitized =
    segment.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "x";
  if (sanitized.length <= 50) return sanitized;
  const prefix = sanitized.slice(0, 41).replace(/-+$/g, "");
  return `${prefix}-${hashSegment(segment)}`;
};

/**
 * Channel prefix for a stack+stage, e.g. `/alchemy/my-app/dev-sam`.
 * The leading segment is the AppSync channel namespace name.
 */
export const channelPrefix = (
  namespace: string,
  stack: string,
  stage: string,
) => `/${namespace}/${sanitizeSegment(stack)}/${sanitizeSegment(stage)}`;

/** Environment variables never forwarded from the sandbox to the local child. */
export const ENV_BLACKLIST: ReadonlySet<string> = new Set([
  "AWS_LAMBDA_LOG_GROUP_NAME",
  "AWS_LAMBDA_LOG_STREAM_NAME",
  "AWS_LAMBDA_RUNTIME_API",
  "AWS_EXECUTION_ENV",
  "AWS_LAMBDA_INITIALIZATION_TYPE",
  "AWS_XRAY_DAEMON_ADDRESS",
  "AWS_XRAY_DAEMON_PORT",
  "AWS_XRAY_CONTEXT_MISSING",
  "LD_LIBRARY_PATH",
  "LAMBDA_TASK_ROOT",
  "LAMBDA_RUNTIME_DIR",
  "PATH",
  "PWD",
  "LANG",
  "NODE_PATH",
  "NODE_OPTIONS",
  "SHLVL",
  "_HANDLER",
]);

/** Split a JSON-encoded body into ordered packets. */
export const encodePackets = (
  type: MessageType,
  source: string,
  id: string,
  body: unknown,
): Packet[] => {
  const bytes = Buffer.from(JSON.stringify(body ?? {}), "utf8");
  const packets: Packet[] = [];
  let index = 0;
  for (let offset = 0; ; offset += CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + CHUNK_SIZE);
    const final = offset + CHUNK_SIZE >= bytes.length;
    packets.push({
      type,
      source,
      id,
      index,
      data: chunk.toString("base64"),
      final,
    });
    index++;
    if (final) break;
  }
  return packets;
};

export interface Message {
  type: MessageType;
  source: string;
  id: string;
  body: string;
}

/**
 * Reassembles packets (possibly out of order, interleaved across ids) into
 * complete messages.
 */
export class PacketAssembler {
  private pending = new Map<
    string,
    { packets: Map<number, Packet>; total: number | undefined }
  >();

  /** Feed one packet; returns the completed message if this was the last piece. */
  push(packet: Packet): Message | undefined {
    let entry = this.pending.get(packet.id);
    if (!entry) {
      entry = { packets: new Map(), total: undefined };
      this.pending.set(packet.id, entry);
    }
    entry.packets.set(packet.index, packet);
    if (packet.final) {
      entry.total = packet.index + 1;
    }
    if (entry.total === undefined || entry.packets.size < entry.total) {
      return undefined;
    }
    this.pending.delete(packet.id);
    const chunks: Buffer[] = [];
    for (let i = 0; i < entry.total; i++) {
      const piece = entry.packets.get(i);
      if (!piece) return undefined; // duplicate `final` with missing middle — drop
      chunks.push(Buffer.from(piece.data, "base64"));
    }
    return {
      type: packet.type,
      source: packet.source,
      id: packet.id,
      body: Buffer.concat(chunks).toString("utf8"),
    };
  }
}
