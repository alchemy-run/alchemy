import * as Layer from "effect/Layer";
import { StorageTask, StorageTaskProvider } from "./StorageTask.ts";

export const resources = [StorageTask];

export const layers = () => Layer.mergeAll(StorageTaskProvider());
