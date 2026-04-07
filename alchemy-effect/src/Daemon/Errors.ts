import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

// Schema-based errors used in the RPC contract (shared between client and server)

export class ProcessAlreadyExists extends Schema.TaggedClass<ProcessAlreadyExists>()(
  "ProcessAlreadyExists",
  { id: Schema.String },
) {}

export class ProcessNotFound extends Schema.TaggedClass<ProcessNotFound>()(
  "ProcessNotFound",
  { id: Schema.String },
) {}

// Data-based errors used only by the server

export class DaemonAlreadyRunning extends Data.TaggedError(
  "DaemonAlreadyRunning",
)<{
  readonly pid: number | undefined;
}> {
  get message() {
    return this.pid !== undefined
      ? `Daemon already running (pid ${this.pid})`
      : "Daemon already running";
  }
}

export class LockCompromised extends Data.TaggedError("LockCompromised")<{
  readonly lockDir: string;
}> {}
