import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import type { CloudEvent } from "../Eventarc/EventSource.ts";
import type { Database } from "./Database.ts";
import { decodeDocumentEventData } from "./internal/DocumentEventData.ts";

/** Firestore document change kinds; `written` is any of the other three. */
export type DocumentEventKind = "created" | "updated" | "deleted" | "written";

/** One Firestore document change. */
export interface DocumentEvent {
  /** What happened to the document. */
  kind: Exclude<DocumentEventKind, "written">;
  /** Document path within the database, e.g. `users/alice`. */
  document: string;
  /** The document's fields after the change (`undefined` when deleted). */
  value: Record<string, unknown> | undefined;
  /** The document's fields before the change (`undefined` when created). */
  oldValue: Record<string, unknown> | undefined;
  /** Field paths an update changed. */
  updatedFields: string[];
  /** RFC3339 time of the change. */
  time: string | undefined;
  /**
   * Path wildcards matched in the `document` pattern, e.g. `{ userId: "alice" }`
   * for `users/{userId}`.
   */
  params: Record<string, string>;
}

export interface DocumentEventSourceProps {
  /**
   * Document path pattern within the database: `users/{userId}` matches one
   * level, `users/{path=**}` every document below `users`.
   */
  document: string;
  /**
   * Change kinds to deliver. One Eventarc trigger is created per kind;
   * `written` is a single trigger for all three.
   * @default ["written"]
   */
  kinds?: DocumentEventKind[];
  /** Delivery path prefix on the host. */
  path?: string;
}

export type DocumentEventsHandler<Req> = (event: DocumentEvent) => Effect.Effect<void, never, Req>;

export type DocumentEventSourceService = <Req = never>(
  database: Database,
  props: DocumentEventSourceProps,
  process: DocumentEventsHandler<Req>,
) => Effect.Effect<void, never, never>;

/**
 * Event source delivering a Firestore {@link Database}'s document changes —
 * created, updated, deleted — to the hosting compute, through Eventarc's
 * native Firestore events.
 *
 * `GCP.Firestore.DocumentEventSourceLive` creates one Eventarc trigger per
 * change kind, filtered to the database and the document pattern, and
 * delegates delivery to `GCP.Eventarc.EventSource` (provide
 * `GCP.Run.EventarcEventSource`). Each delivery is one change, with the
 * document's fields decoded to plain values.
 *
 * Consume it through {@link consumeDocumentEvents}.
 *
 * ### Consuming document changes
 * **Example:** New users
 * ```typescript
 * yield* GCP.Firestore.consumeDocumentEvents(
 *   database,
 *   { document: "users/{userId}", kinds: ["created"] },
 *   (event) => Effect.log(`welcome ${event.params.userId}: ${event.value?.email}`),
 * );
 * // …provided with GCP.Firestore.DocumentEventSourceLive and GCP.Run.EventarcEventSource
 * ```
 *
 * **Example:** Every change below a collection
 * ```typescript
 * yield* GCP.Firestore.consumeDocumentEvents(
 *   database,
 *   { document: "orders/{path=**}" },
 *   (event) => Effect.log(`${event.kind} ${event.document}`),
 * );
 * ```
 *
 * @binding
 * @category Firestore
 */
export interface DocumentEventSource extends Binding.Service<
  DocumentEventSource,
  "GCP.Firestore.DocumentEventSource",
  DocumentEventSourceService
> {}

export const DocumentEventSource = Binding.Service<DocumentEventSource>(
  "GCP.Firestore.DocumentEventSource",
);

/**
 * Subscribe an Effect handler to a Firestore {@link Database}'s document
 * changes. See {@link DocumentEventSource}.
 */
export const consumeDocumentEvents = <Req = never, ResourceReq = never>(
  database: Database | Effect.Effect<Database, never, ResourceReq>,
  props: DocumentEventSourceProps,
  process: DocumentEventsHandler<Req>,
): Effect.Effect<void, never, DocumentEventSource | ResourceReq> =>
  (Effect.isEffect(database) ? database : Effect.succeed(database)).pipe(
    Effect.flatMap((value) => DocumentEventSource.use((source) => source(value, props, process))),
  );

/** `users/{userId}` against `users/alice` → `{ userId: "alice" }`. */
const matchParams = (pattern: string, document: string) => {
  const params: Record<string, string> = {};
  const patternParts = pattern.split("/");
  const parts = document.split("/");
  patternParts.forEach((part, index) => {
    const wildcard = /^\{(\w+)(=\*\*)?\}$/.exec(part);
    if (!wildcard) return;
    params[wildcard[1]!] = wildcard[2] ? parts.slice(index).join("/") : (parts[index] ?? "");
  });
  return params;
};

/**
 * Decode an Eventarc Firestore CloudEvent (its `application/protobuf`
 * payload) into a {@link DocumentEvent}.
 */
export const toDocumentEvent = (pattern: string, event: CloudEvent): DocumentEvent => {
  const data = decodeDocumentEventData(
    ArrayBuffer.isView(event.data) ? (event.data as Uint8Array) : new Uint8Array(),
  );
  const document = (event.subject ?? "").replace(/^documents\//, "");
  const kind = event.type.split(".").at(-1) as DocumentEvent["kind"];
  return {
    kind,
    document,
    value: data.value?.fields,
    oldValue: data.oldValue?.fields,
    updatedFields: data.updatedFields,
    time: event.time,
    params: matchParams(pattern, document),
  };
};
