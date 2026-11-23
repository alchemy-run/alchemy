import { createHash } from "node:crypto";

/** A content-addressed id: nothing the prover reads. */
export const idOf = (seq: number) => createHash("sha256").update(String(seq)).digest("hex");

/** Whether a note says nothing: `trim` is not something the prover reads. */
export const isBlank = (text: string) => text.trim() === "";
