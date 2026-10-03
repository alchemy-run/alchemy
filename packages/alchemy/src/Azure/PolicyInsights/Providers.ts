import * as Layer from "effect/Layer";
import { Attestation, AttestationProvider } from "./Attestation.ts";

export const resources = [Attestation];
export const layers = () => Layer.mergeAll(AttestationProvider());
