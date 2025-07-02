/**
 * Compatibility presets for Cloudflare Workers
 * 
 * These presets provide common sets of compatibility flags to avoid
 * users having to remember which flags they need for common use cases.
 */

export type CompatibilityPreset = "node";

/**
 * Mapping of compatibility presets to their respective compatibility flags
 */
export const COMPATIBILITY_PRESETS: Record<CompatibilityPreset, string[]> = {
  /**
   * Node.js compatibility preset
   * Enables Node.js APIs and runtime compatibility
   */
  node: ["nodejs_compat"],
};

/**
 * Get the compatibility flags for a given preset
 */
export function getCompatibilityFlags(preset: CompatibilityPreset): string[] {
  return COMPATIBILITY_PRESETS[preset] || [];
}

/**
 * Union preset compatibility flags with user-provided flags
 */
export function unionCompatibilityFlags(
  preset: CompatibilityPreset | undefined,
  userFlags: string[] = []
): string[] {
  if (!preset) {
    return userFlags;
  }
  
  const presetFlags = getCompatibilityFlags(preset);
  return Array.from(new Set([...presetFlags, ...userFlags]));
}