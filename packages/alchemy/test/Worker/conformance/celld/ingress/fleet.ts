import * as Celld from "@/Celld";

/**
 * Deterministic per-runner hostname on the standing Cloudflare test zone —
 * same convention as the other custom-domain suites (stable across runs of
 * the same PR/user, distinct across runners).
 */
const runner = (process.env.PULL_REQUEST ?? process.env.USER ?? "local")
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-");
export const INGRESS_DOMAIN = `celld-ingress-${runner}.alchemy-test-2.us`;

/** Single-node fleet: ingress behavior is node-count independent. */
export class IngressCells extends Celld.Fleet<IngressCells>()("IngressCells", {
  instances: 1,
}) {}

/**
 * The exposed worker's tag. Kept in its own module so the deploy module
 * ([worker.ts](./worker.ts)) and the test stay acyclic.
 */
export class IngressWorker extends Celld.Worker<IngressWorker>()(
  "IngressWorker",
) {}
