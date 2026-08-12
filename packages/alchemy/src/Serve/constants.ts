/**
 * Wiring-handshake sentinel for the `alchemy/serve` runtime bridge.
 *
 * The bridge module embeds this exact byte sequence (as a literal, so it
 * survives bundling and minification into any foreign server bundle that
 * imports it). At deploy time, collect-only mode scans the built server
 * bundle for it: impl present + sentinel absent means the user wired the
 * construct but forgot to mount the bridge in their framework entry — a
 * deploy error with a per-framework fix-it snippet.
 *
 * This module is pure data — safe to import from plan-time code (the
 * sentinel scanner) without pulling in the runtime bridge.
 */
export const SERVE_SENTINEL = "__ALCHEMY_SERVE_v1__";
