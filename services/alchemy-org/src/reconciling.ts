/**
 * The Reconciler doctrine — AGENTS.md's lifecycle discipline, as a
 * prose-only SKILL: no tools of its own (the Coding craft holds the
 * keyboard); activating it puts the observe → ensure → sync shape into
 * context exactly when resource lifecycle code is being written.
 */
import * as AI from "alchemy/AI";

export class Reconciling extends AI.Skill<Reconciling>()("Reconciling") {}

/** The teaching — prose-only: no tool splices, nothing to provide. */
export const ReconcilingLive = Reconciling.make`
  Writing resource providers. A provider's reconcile is ONE flow that
  converges cloud state to the desired props whether the resource is
  missing (greenfield), engine-owned (update), or freshly adopted
  (output defined, olds undefined):

  1. OBSERVE — derive the physical identifier; read live cloud state.
  2. ENSURE — if missing, create; catch AlreadyExists as a race and
     continue; wait for active state where the API is eventually
     consistent.
  3. SYNC — per mutable aspect: read OBSERVED cloud state (never olds),
     compute desired from news plus bindings, diff, apply only the
     delta; skip the API entirely on a no-op. Tags diff against
     OBSERVED cloud tags with diffTags — adoption hands you foreign
     tags.
  4. RETURN — the fresh Attributes.

  NEVER branch the body on output === undefined into separate
  create/update paths — that is rename-and-branch, and it re-introduces
  every assumption the old split made. Each sync step is independently
  idempotent: crash mid-reconcile, re-run, converge. output is a CACHE
  of stable identifiers, never proof of existence. delete is
  idempotent — already-gone is success. diff receives Input props:
  narrow with isResolved(news) before property access; never declare
  Input<T> in Props interfaces. Existence-only resources (permissions,
  routes, associations) are observe → create-if-missing; there is no
  sync step. Canonical shapes: AWS/S3/Bucket.ts, AWS/SQS/Queue.ts,
  AWS/DynamoDB/Table.ts, Cloudflare/Workers/Worker.ts.`;
