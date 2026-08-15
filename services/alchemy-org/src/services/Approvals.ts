/**
 * The APPROVAL GATE — the org's human-in-the-loop seam, USERLAND by
 * design: tools are Effects, so a dangerous tool gates itself by
 * `yield*`ing this service inside its own impl — no driver hook, no
 * pipeline middleware (the dsh lesson translated to our shape).
 *
 * Fail-closed when armed: only an explicit `allowed-once` proceeds;
 * a timeout or missing operator is `unavailable`, and the tool treats
 * anything but `allowed-once` as "do not act". Each grant is ONE-SHOT
 * — nothing is remembered across calls.
 *
 * The gate is DISARMED by default (`ask` returns `allowed-once`
 * immediately): this is a trusted-operator local deploy and the
 * review pipeline's value is autonomy. Arm it with `ORG_APPROVALS=ask`
 * — every gated tool then parks until the operator answers in the UI.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type ApprovalOutcome = "allowed-once" | "rejected" | "unavailable";

export interface ApprovalRequest {
  readonly id: string;
  readonly session: { readonly term: string; readonly key: string };
  /** What the operator is approving — one human-readable line. */
  readonly action: string;
  readonly at: number;
}

export class Approvals extends Context.Service<
  Approvals,
  {
    /** Ask for one-shot permission; resolves when the operator
     *  answers, or `unavailable` after the window closes. */
    readonly ask: (request: {
      readonly session: { readonly term: string; readonly key: string };
      readonly action: string;
    }) => Effect.Effect<ApprovalOutcome>;
    /** Requests currently awaiting an answer — the UI's list. */
    readonly pending: () => Effect.Effect<ReadonlyArray<ApprovalRequest>>;
    /** Answer one request; false when it is unknown (answered or
     *  expired — idempotent, the world outranks the click). */
    readonly answer: (
      id: string,
      outcome: "allowed-once" | "rejected",
    ) => Effect.Effect<boolean>;
  }
>()("alchemy-org/Approvals") {}
