import * as Data from "effect/Data";

/** The user dismissed the active terminal interaction. */
export class TerminalCancelled extends Data.TaggedError("TerminalCancelled") {}

/** An interactive operation was requested without an interactive terminal. */
export class NonInteractiveTerminal extends Data.TaggedError(
  "NonInteractiveTerminal",
)<{
  readonly operation: string;
  readonly message: string;
}> {}

/** The platform's browser launcher exited unsuccessfully. */
export class BrowserOpenFailed extends Data.TaggedError("BrowserOpenFailed")<{
  readonly command: string;
  readonly exitCode: number;
}> {}
