/**
 * What a node's bootstrap knows while it builds its entrypoints: that it is
 * a node, and the classes Layers built there host (a Domain platform's
 * class, built by the model's Layer rather than exported as a class).
 *
 * @internal
 */
import type { HostedDurableObject } from "../DurableObject.ts";

export const NodeHost: {
  /** Set by the node's bootstrap before it builds its entrypoints. */
  active: boolean;
  /** Classes hosted by Layers, in the order they were built. */
  readonly hosted: Array<HostedDurableObject>;
} = { active: false, hosted: [] };
