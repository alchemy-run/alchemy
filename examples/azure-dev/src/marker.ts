/**
 * The CLI dev test (test/dev.test.ts) rewrites this value in place, with
 * `alchemy dev` running, to prove a code change restarts the local Function
 * without a deploy. It then restores it. The checked-in value is always `v1`.
 */
export const MARKER = "azure-dev-marker-v1";
