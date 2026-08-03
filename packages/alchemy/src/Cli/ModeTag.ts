import type { ProviderMode } from "../ProviderMode.ts";

/**
 * Pure formatting shared by the plan/deploy renderers (Ink TUI +
 * non-interactive LoggingCli) for the local-vs-live provider-mode
 * indicator on a resource row.
 *
 * The rule: mark the EXCEPTIONS relative to the run's default mode so
 * output stays quiet in the common case.
 *
 * - `alchemy deploy` (default `"live"`): rows resolved to the local
 *   provider (e.g. leftover dev rows being deleted/replaced) are tagged
 *   `local`.
 * - `alchemy dev` (default `"local"`): rows resolved to the live provider
 *   (`Alchemy.remote()` opt-outs) are tagged `remote` — matching the
 *   `Alchemy.remote()` vocabulary users see. The persisted enum stays
 *   `"live"`; only the display says `remote`.
 * - Mode-agnostic providers have no resolved mode (`undefined`) — nothing
 *   is shown.
 * - Mode-switch replacements ALWAYS annotate the transition
 *   (e.g. `local → live`), regardless of the run default.
 */

/** The display label for a minority-mode row (`"live"` renders as `remote`). */
export const modeLabel = (mode: ProviderMode): string =>
  mode === "live" ? "remote" : "local";

/**
 * The mode note for a resource row, or `undefined` when nothing should be
 * shown (the quiet common case).
 *
 * @param mode the mode the node's provider was resolved for (`undefined`
 *   for mode-agnostic providers — never annotated)
 * @param priorMode for replacements, the mode the old generation was
 *   created with; when it differs from `mode` the transition is shown
 * @param defaultMode the run-level default (`alchemy dev` → `"local"`,
 *   otherwise `"live"`); `undefined` is treated as `"live"`
 */
export const formatModeNote = (options: {
  mode: ProviderMode | undefined;
  priorMode?: ProviderMode | undefined;
  defaultMode: ProviderMode | undefined;
}): string | undefined => {
  const { mode, priorMode } = options;
  if (mode === undefined) return undefined;
  // A genuine mode switch is always surfaced as the raw transition.
  if (priorMode !== undefined && priorMode !== mode) {
    return `${priorMode} → ${mode}`;
  }
  const defaultMode = options.defaultMode ?? "live";
  if (mode === defaultMode) return undefined;
  return modeLabel(mode);
};
