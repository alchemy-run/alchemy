import * as Layer from "effect/Layer";
import { Workbook, WorkbookProvider } from "./Workbook.ts";

export const resources = [Workbook];
export const layers = () => Layer.mergeAll(WorkbookProvider());
