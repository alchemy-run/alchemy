import * as Data from "effect/Data";
import { UserFacingError } from "../../UserFacingError.ts";

/** The user dismissed the active terminal interaction. */
export class TerminalCancelled extends Data.TaggedError("TerminalCancelled") {}

/** An interactive operation was requested without an interactive terminal. */
export class NonInteractiveTerminal extends Data.TaggedError(
  "NonInteractiveTerminal",
)<{
  readonly operation: string;
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

/** The platform's browser launcher exited unsuccessfully. */
export class BrowserOpenFailed extends Data.TaggedError("BrowserOpenFailed")<{
  readonly command: string;
  readonly exitCode: number;
}> {}
