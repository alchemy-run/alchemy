// Inert stub for `sharp` (see next.config.mjs). Reached only by the
// plan-only half of the backend import graph (alchemy's local Images
// simulator lazy-imports it); never called inside the deployed Worker.
export default function sharp() {
  throw new Error(
    "sharp is not available inside the Worker (local images simulation only)",
  );
}
