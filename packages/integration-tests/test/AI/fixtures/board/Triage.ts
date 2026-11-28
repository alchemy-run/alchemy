import * as AI from "@alchemy.run/ai";
import { Labeler } from "./Labeler.ts";

/** Labels one issue of the board. A session is started as the labeler its commands are sent as. */
export class Triage extends AI.Process<Triage>()("Triage", { as: [Labeler] }) {}
