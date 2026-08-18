/**
 * Wiring-handshake sentinel for the `alchemy/Serve` runtime bridge.
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

/**
 * Static property key under which a Website class carries its
 * cloud-specific serve bridge — the runtime half `Serve.toHandler` dispatches
 * matched requests to.
 *
 * Both clouds attach their bridge here at class construction
 * (`Cloudflare/Workers/ServeBridge.ts`, `AWS/Lambda/ServeBridge.ts`), so
 * each rides the *site module's own import graph* into whatever bundle
 * contains the site — the `alchemy/Serve` core never has to import (and
 * foreign bundlers never have to carry) both clouds' runtime recipes.
 *
 * The value is a {@link ServeBridge}-shaped object (see `Serve.ts`). Pure
 * data — safe to import anywhere.
 */
export const SERVE_BRIDGE_KEY = "~alchemy/Serve/bridge";
