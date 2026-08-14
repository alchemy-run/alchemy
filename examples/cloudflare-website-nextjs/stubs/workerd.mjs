// Inert stub for the `workerd` npm package (see next.config.mjs).
//
// The backend module's import graph includes alchemy's IaC half (the
// engine imports app/backend.ts at plan time to collect bindings). That
// half is plan-only — it never runs inside the deployed Worker — but
// Turbopack's server-component build still parses every statically
// reachable module, and `workerd` resolves its native binary path at
// module scope (an unparseable binary + README). This stub satisfies the
// package's import surface with inert values; alchemy's vite-based tiers
// apply the same stub automatically.
export default "";
export const compatibilityDate = "";
export const version = "";
