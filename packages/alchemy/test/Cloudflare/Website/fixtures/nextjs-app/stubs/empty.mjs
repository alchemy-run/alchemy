// Inert stand-in for the `workerd` npm package (see next.config.mjs
// `turbopack.resolveAlias`): the real module resolves a native binary the
// Next bundler cannot parse. Mirrors the export surface consumed by
// `@alchemy.run/cloudflare-runtime` (binary path / compatibilityDate /
// version) — never invoked at runtime; the explicit-tier request path never
// starts a local workerd host (that is engine/sidecar machinery).
export const compatibilityDate = "0000-00-00";
export const version = "0.0.0";
export default "/dev/null/workerd-stubbed-for-next-bundling";
