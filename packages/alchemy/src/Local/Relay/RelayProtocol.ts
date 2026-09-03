/**
 * Wire protocol between the dev relay (a Fly Service, see `RelayService.ts`)
 * and the connector running in the `alchemy dev` sidecar. One WebSocket per
 * namespace carries many concurrent HTTP exchanges, multiplexed by a stream
 * id:
 *
 * - **Text frames** are JSON {@link ControlFrame}s: request/response heads,
 *   end-of-body markers, aborts, and the hello handshake.
 * - **Binary frames** are body chunks: a 4-byte big-endian stream id followed
 *   by the bytes. Chunks stay well under the 1 MiB WebSocket message limit.
 *
 * Shared by the relay (bundled for Fly) and the Node/Bun connector, so it
 * must stay free of platform imports.
 */

/** Largest body chunk sent in one binary frame. */
export const CHUNK_SIZE = 64 * 1024;

/** Path on the relay host the connector dials. */
export const CONNECT_PATH = "/__relay/connect";

/** Header carrying the connector's bearer token on connect. */
export const AUTH_HEADER = "authorization";

/** Query parameter naming the namespace a connector claims. */
export const NAMESPACE_PARAM = "namespace";

/** Hop-by-hop / framing headers that must not be forwarded either way. */
export const STRIPPED_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "upgrade",
  "te",
  "trailer",
  "proxy-connection",
  "expect",
]);

export type HeaderList = ReadonlyArray<readonly [string, string]>;

/** Relay → connector, right after the socket opens. */
export interface HelloFrame {
  readonly t: "hello";
  /** Namespace the socket serves. */
  readonly namespace: string;
  /** Relay domain: public hosts are `<label>.<namespace>.<domain>`. */
  readonly domain: string;
  /** Public scheme (`https`, or `http` on relays without TLS). */
  readonly scheme: string;
  /**
   * State of the namespace's TLS certificate (`*.<namespace>.<domain>`):
   * `ready`, `provisioning` (being issued — the relay sends a fresh hello
   * when it is uploaded), or `unavailable` (issuance failed; HTTPS to the
   * namespace will not work until the relay retries).
   */
  readonly certificate?: "ready" | "provisioning" | "unavailable";
  /** Why the certificate is `unavailable`, for the developer's terminal. */
  readonly certificateError?: string;
}

/** Relay → connector: a public request arrived for `label`. */
export interface RequestFrame {
  readonly t: "req";
  readonly id: number;
  readonly method: string;
  /** Path and query, e.g. `/echo?x=1`. */
  readonly url: string;
  /** The public host the client dialed, e.g. `api.sam.dev.alchemy.run`. */
  readonly host: string;
  /** The label routed to (`api`). */
  readonly label: string;
  readonly headers: HeaderList;
  /** Whether body chunks follow (ended by an `end` frame). */
  readonly body: boolean;
}

/** Connector → relay: the response head for `id`. */
export interface ResponseFrame {
  readonly t: "res";
  readonly id: number;
  readonly status: number;
  readonly headers: HeaderList;
  /** Whether body chunks follow (ended by an `end` frame). */
  readonly body: boolean;
}

/** Either direction: no more body chunks for `id`. */
export interface EndFrame {
  readonly t: "end";
  readonly id: number;
}

/** Either direction: give up on `id` (client went away, upstream failed). */
export interface AbortFrame {
  readonly t: "abort";
  readonly id: number;
  readonly message?: string;
}

export type ControlFrame =
  | HelloFrame
  | RequestFrame
  | ResponseFrame
  | EndFrame
  | AbortFrame;

export const encodeControl = (frame: ControlFrame): string =>
  JSON.stringify(frame);

export const decodeControl = (text: string): ControlFrame =>
  JSON.parse(text) as ControlFrame;

/** Prefix a body chunk with its stream id. */
export const encodeChunk = (id: number, chunk: Uint8Array): Uint8Array => {
  const out = new Uint8Array(4 + chunk.byteLength);
  new DataView(out.buffer).setUint32(0, id);
  out.set(chunk, 4);
  return out;
};

/** Split a binary frame back into its stream id and bytes. */
export const decodeChunk = (
  data: ArrayBuffer | Uint8Array,
): { readonly id: number; readonly chunk: Uint8Array } => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const id = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
  return { id, chunk: bytes.subarray(4) };
};

/** Headers worth forwarding, as a plain list (Headers objects don't serialize). */
export const forwardableHeaders = (
  headers: Iterable<readonly [string, string]>,
): HeaderList => {
  const out: Array<readonly [string, string]> = [];
  for (const [name, value] of headers) {
    if (!STRIPPED_HEADERS.has(name.toLowerCase())) out.push([name, value]);
  }
  return out;
};

/** Split `host` into `{ label, namespace }` under `domain`, or `undefined`. */
export const parsePublicHost = (
  host: string,
  domain: string,
): { readonly label: string; readonly namespace: string } | undefined => {
  const hostname = host.split(":")[0]!.toLowerCase();
  const suffix = `.${domain.toLowerCase()}`;
  if (!hostname.endsWith(suffix)) return undefined;
  const labels = hostname.slice(0, -suffix.length).split(".");
  if (labels.length !== 2 || labels.some((l) => l === "")) return undefined;
  return { label: labels[0]!, namespace: labels[1]! };
};

/** The public host for `label` in `namespace`. */
export const publicHost = (
  label: string,
  namespace: string,
  domain: string,
): string => `${label}.${namespace}.${domain}`;
