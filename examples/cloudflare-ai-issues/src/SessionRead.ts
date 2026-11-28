import { SessionPage, SessionState } from "@alchemy.run/ai/Session";
import * as Schema from "effect/Schema";

/**
 * What the page reads of one issue's session: where it stands, and the
 * transcript items it stored after the one the page last saw.
 */
export const SessionRead = Schema.Struct({ ...SessionState.fields, ...SessionPage.fields });
export type SessionRead = typeof SessionRead.Type;
