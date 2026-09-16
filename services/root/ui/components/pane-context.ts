/**
 * WHICH PANE a click happens in — the reference-chain seam.
 *
 * App provides the pane around each split's content; a message
 * reference (`PostRef`) read here knows its source pane and opens
 * its target RIGHT-ADJACENT to it (`openPane(…, { after })`).
 * Undefined outside the stack (the feed, the center thread): a
 * reference there starts the chain at the stack's head.
 */
import type { Pane } from "@/lib/routes";
import { createContext } from "react";

export const PaneContext = createContext<Pane | undefined>(undefined);
