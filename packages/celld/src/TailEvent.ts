/** A completed Dynamic Worker fetch invocation delivered to a tail handler. */
export interface TailEvent {
  /** Native name of the loaded script. */
  readonly scriptName: string;
  /** Invocation start time in Unix milliseconds. */
  readonly eventTimestamp: number;
  /** Request metadata and the response, when one was produced. */
  readonly event: {
    /** Metadata for the loaded Worker's incoming request. */
    readonly request: {
      /** Celld supplies an empty Cloudflare metadata object. */
      readonly cf: Record<string, never>;
      /** Lowercase header names; repeated values are joined with a comma and space. */
      readonly headers: Record<string, string>;
      /** HTTP method of the invocation. */
      readonly method: string;
      /** Full URL of the invocation. */
      readonly url: string;
    };
    /** Null when the invocation failed before producing a response. */
    readonly response: { readonly status: number } | null;
  };
  /** Console records, capped by the native runtime at 256 KiB per invocation. */
  readonly logs: ReadonlyArray<{
    /** Time of the console call in Unix milliseconds. */
    readonly timestamp: number;
    /** Native console level. */
    readonly level: string;
    /** Stringified console arguments. */
    readonly message: ReadonlyArray<string>;
  }>;
  /** Uncaught invocation failures. */
  readonly exceptions: ReadonlyArray<{
    /** Time of the failure in Unix milliseconds. */
    readonly timestamp: number;
    /** Native exception name. */
    readonly name: string;
    /** Native exception message. */
    readonly message: string;
  }>;
  /** Whether the invocation completed without an uncaught failure. */
  readonly outcome: "ok" | "exception";
}
