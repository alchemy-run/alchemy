import * as Celld from "@/Celld";

/** The tag-only fleet class — no impl/main here, so imports stay acyclic. */
export class Cells extends Celld.Fleet<Cells>()("Cells") {}
