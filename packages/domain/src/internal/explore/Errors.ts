/**
 * Engine errors: the engine could not execute the model as the host
 * would. They are never property violations and never a clean result: a
 * search that meets one ends `CutOff("engine-error")`.
 */
import * as Data from "effect/Data";

export type EngineErrorKind =
  /** An async effect: the synchronous runner could not finish the move. */
  | "AsyncEffect"
  /** `Clock.sleep` (or a policy `retry` schedule) inside a move. */
  | "ClockSleep"
  /** `Math.random` or `crypto.randomUUID` inside a move. */
  | "HiddenRandomness"
  /** Fake or model state that is not plain JSON. */
  | "NonJsonState"
  /** A replay took another branch, met another choice, or reached another state. */
  | "ReplayDiverged"
  /** A replay on a fresh build gave another state: a layer holds state the world does not. */
  | "HiddenState"
  /** A model member the engine does not host (streams, sagas, an abstract view that feeds a consumer). */
  | "Unsupported"
  /** `choose`, `spend` or `fakeState` outside a move. */
  | "OutsideMove"
  /** A trace or Story fixture was made on another model (`modelHash` differs). */
  | "ModelChanged"
  /** A worker failed, timed out, or runs another config. */
  | "Worker";

/** Thrown inside the host; the move runner turns it into an engine error. */
export class EngineFault extends Data.TaggedError("EngineFault")<{
  readonly kind: EngineErrorKind;
  readonly detail: string;
  readonly message: string;
}> {
  constructor(kind: EngineErrorKind, detail: string) {
    super({ kind, detail, message: `${kind}: ${detail}` });
  }
}

export interface EngineError {
  readonly kind: EngineErrorKind;
  readonly detail: string;
  /** The move during which it happened, if any. */
  readonly move?: string;
}

/** The typed failure of `explore`: the engine errors of the run. */
export class ExploreError extends Data.TaggedError("ExploreError")<{
  readonly errors: ReadonlyArray<EngineError>;
}> {}

export class UnsupportedStoryTrace extends Data.TaggedError("UnsupportedStoryTrace")<{
  readonly reason: string;
}> {}

/** The platform lost the call (crash, deploy, network): a modeled fault, not a defect. */
export class HostFault extends Data.TaggedError("HostFault")<{
  readonly where: string;
  readonly message: string;
}> {
  constructor(where: string) {
    super({ where, message: `host fault: ${where}` });
  }
}
