import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { TopicEventSourceProps, TopicMessage } from "../PubSub/TopicEventSource.ts";

/** One Cloud Audit Logs entry: a Google API call that touched a resource. */
export interface AuditLogEvent {
  /** Service that handled the call, e.g. `secretmanager.googleapis.com`. */
  serviceName: string;
  /**
   * Full RPC method name, e.g.
   * `google.cloud.secretmanager.v1.SecretManagerService.AddSecretVersion`.
   */
  methodName: string;
  /** Resource the call targeted, e.g. `projects/123/secrets/s/versions/2`. */
  resourceName: string;
  /** Principal that made the call, when the log records it. */
  principalEmail: string | undefined;
  /** gRPC status of the call; `undefined` (or code 0) when it succeeded. */
  status: { code?: number; message?: string } | undefined;
  /** RFC3339 time of the call. */
  timestamp: string;
  /** Log the entry was written to: `…/logs/cloudaudit.googleapis.com%2Factivity` or `%2Fdata_access`. */
  logName: string;
  /** Unique id of the log entry; use it to deduplicate redeliveries. */
  insertId: string;
  /** The whole `LogEntry`, including `protoPayload.request` / `response` when logged. */
  entry: Record<string, unknown>;
}

export interface AuditLogEventSourceProps extends Omit<TopicEventSourceProps, "filter"> {
  /**
   * Cloud Logging filter selecting the audit log entries to deliver, e.g.
   * `protoPayload.serviceName="secretmanager.googleapis.com"`. Prefer the
   * generated `consume<Resource>AuditLogs` functions, which build it.
   */
  filter: Input<string>;
}

export type AuditLogEventsHandler<Req> = (
  events: Stream.Stream<AuditLogEvent>,
) => Effect.Effect<void, never, Req>;

export type AuditLogEventSourceService = <Req = never>(
  id: string,
  props: AuditLogEventSourceProps,
  process: AuditLogEventsHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source delivering Cloud Audit Logs entries — any Google API call on
 * any resource — to the hosting compute.
 *
 * `GCP.Logging.AuditLogEventSourceLive` routes matching entries through a
 * Logging sink into a Pub/Sub topic owned by the host, then delegates
 * delivery to the provided `GCP.PubSub.TopicEventSource` implementation.
 *
 * Use it for services that emit no events of their own. Admin Activity
 * entries (calls that change configuration or metadata) are always
 * written. Data Access entries (reads, and calls that read or write user
 * data) are written only where the project enables Data Access audit logs
 * for the service; BigQuery writes them by default.
 *
 * Consume it through {@link consumeAuditLogs}, or through a resource's
 * generated `consume<Resource>AuditLogs`.
 *
 * ### Consuming audit logs
 * **Example:** Every KMS key-version change in the project
 * ```typescript
 * yield* GCP.Logging.consumeAuditLogs(
 *   "KeyChanges",
 *   { filter: 'protoPayload.serviceName="cloudkms.googleapis.com"' },
 *   (events) =>
 *     events.pipe(
 *       Stream.runForEach((event) => Effect.log(`${event.methodName} ${event.resourceName}`)),
 *     ),
 * );
 * // …provided with GCP.Logging.AuditLogEventSourceLive and GCP.Run.TopicEventSource
 * ```
 *
 * @binding
 * @category Logging
 */
export interface AuditLogEventSource extends Binding.Service<
  AuditLogEventSource,
  "GCP.Logging.AuditLogEventSource",
  AuditLogEventSourceService
> {}

export const AuditLogEventSource = Binding.Service<AuditLogEventSource>(
  "GCP.Logging.AuditLogEventSource",
);

/**
 * Subscribe an Effect handler to Cloud Audit Logs entries matching
 * `props.filter`. See {@link AuditLogEventSource}.
 */
export const consumeAuditLogs = <Req = never>(
  id: string,
  props: AuditLogEventSourceProps,
  process: AuditLogEventsHandler<Req>,
): Effect.Effect<void, never, AuditLogEventSource> =>
  AuditLogEventSource.use((source) => source(id, props, process));

/** Escape `value` for a Cloud Logging regular expression (RE2) inside a quoted string. */
const escapeRegex = (value: string) => value.replace(/[\\.*+?^${}()|[\]"]/g, "\\$&");

/**
 * Cloud Logging filter for audit entries on one resource and its children.
 * Audit logs may name the project by id or number, so the project segment
 * is matched loosely. `methods` are RPC method names without their service
 * prefix (`AddSecretVersion`); omit them for every method.
 */
export const resourceAuditLogFilter = (options: {
  serviceNames: readonly string[];
  resourceName: string;
  methods?: readonly string[];
}) => {
  const path = options.resourceName.replace(/^projects\/[^/]+\//, "");
  const services = options.serviceNames.map((name) => `"${name}"`).join(" OR ");
  const clauses = [
    `logName:"cloudaudit.googleapis.com"`,
    `protoPayload.serviceName=(${services})`,
    `protoPayload.resourceName=~"^projects/[^/]+/${escapeRegex(path)}(/.*)?$"`,
  ];
  if (options.methods && options.methods.length > 0) {
    clauses.push(
      `protoPayload.methodName=~"(^|\\.)(${options.methods.map(escapeRegex).join("|")})$"`,
    );
  }
  return clauses.join(" AND ");
};

const decodeBase64Utf8 = (data: string) => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
};

/** Parse a sink-published `LogEntry` into an {@link AuditLogEvent}. */
export const toAuditLogEvent = ({ message }: TopicMessage) =>
  Effect.sync((): AuditLogEvent => {
    let entry: Record<string, unknown> = {};
    try {
      if (message.data) entry = JSON.parse(decodeBase64Utf8(message.data));
    } catch {
      entry = {};
    }
    const payload = (entry.protoPayload ?? {}) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const auth = (payload.authenticationInfo ?? {}) as { principalEmail?: string };
    return {
      serviceName: text(payload.serviceName),
      methodName: text(payload.methodName),
      resourceName: text(payload.resourceName),
      principalEmail: auth.principalEmail,
      status: payload.status as AuditLogEvent["status"],
      timestamp: text(entry.timestamp) || text(message.publishTime),
      logName: text(entry.logName),
      insertId: text(entry.insertId),
      entry,
    };
  });
