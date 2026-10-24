import * as Layer from "effect/Layer";
import { DataScanner, DataScannerProvider } from "./DataScanner.ts";

export const resources = [DataScanner];
export const layers = () => Layer.mergeAll(DataScannerProvider());
