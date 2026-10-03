import * as Layer from "effect/Layer";
import { FileShare, FileShareProvider } from "./FileShare.ts";
import {
  FileShareSnapshot,
  FileShareSnapshotProvider,
} from "./FileShareSnapshot.ts";

export const resources = [FileShare, FileShareSnapshot];
export const layers = () =>
  Layer.mergeAll(FileShareProvider(), FileShareSnapshotProvider());
