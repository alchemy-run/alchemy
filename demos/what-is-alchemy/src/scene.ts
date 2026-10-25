/** What a step draws. Scenes with a `stage` build up over consecutive steps. */
export type Scene =
  | { kind: "hero"; eyebrow: string; heading: string; lede: string; footer?: string }
  /** Plain IaC (two programs) against Alchemy (one Effect), from the compare page. */
  | { kind: "versus"; stage: 1 | 2 | 3 }
  /** One capability line → IAM policy, env var, typed client. */
  | { kind: "oneLine"; stage: 1 | 2 }
  | { kind: "permissions" }
  /** The Construction and Runtime phases of a Runtime's code. */
  | { kind: "phases"; stage: 1 | 2 }
  /** A service Layer that brings its own infrastructure, swapped from KV to DynamoDB. */
  | { kind: "layers"; variant: "kv" | "dynamo" }
  | { kind: "engine" }
  | { kind: "deploy" }
  /** Where one request goes in dev: Alchemy local, Lambda moved to the cloud, then the others. */
  | { kind: "dev"; stage: 1 | 2 | 3 }
  | { kind: "loop" }
  | { kind: "glance" };

/** One press of →. */
export interface Step {
  /** The heading over the scene (hero scenes carry their own). */
  heading?: string;
  lede?: string;
  /** What to say. Shown in the presenter, never in the video. */
  notes: string;
  scene: Scene;
  /** How long the step's animation runs. */
  frames?: number;
}
