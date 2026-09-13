import * as Layer from "effect/Layer";
import { EditFileLive } from "./EditFile.ts";
import { WriteFileLive } from "./WriteFile.ts";

/**
 * The pen — digest-guarded edits and whole-file writes. The third
 * access level over `coding/Toolbox.ts`'s Read + Run, and the one
 * only the engineer holds: read-only agents (e.g. Verification) are
 * assembled without it, so the access level is a fact of the Layer
 * graph, not of the prompt.
 */
export const WriteTools = Layer.mergeAll(EditFileLive, WriteFileLive);
