import * as Data from "effect/Data";

/** Boat answered with something Alchemy can't use (a missing field, a vanished object). */
export class BoatUnexpectedResponse extends Data.TaggedError("Boat.UnexpectedResponse")<{
  readonly message: string;
}> {}

/** A command ran past its `timeout` and Boat stopped it. */
export class ExecTimedOut extends Data.TaggedError("Boat.ExecTimedOut")<{
  readonly message: string;
  readonly stdout: string;
  readonly stderr: string;
}> {}

/** A saved snapshot Boat could not save. */
export class SnapshotFailed extends Data.TaggedError("Boat.SnapshotFailed")<{
  readonly message: string;
  /** The snapshot's name, or the sandbox whose setup it waited on. */
  readonly snapshot: string;
}> {}

/** An environment variable value Boat's `.env` format can't hold. */
export class InvalidEnvironmentValue extends Data.TaggedError("Boat.InvalidEnvironmentValue")<{
  readonly message: string;
  readonly key: string;
}> {}

/** A snapshot's setup command failed or ran past 10 minutes. */
export class SnapshotSetupFailed extends Data.TaggedError("Boat.SnapshotSetupFailed")<{
  readonly message: string;
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
}> {}
