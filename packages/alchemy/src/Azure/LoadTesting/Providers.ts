import * as Layer from "effect/Layer";
import { LoadTest, LoadTestProvider } from "./LoadTest.ts";
import {
  PlaywrightWorkspace,
  PlaywrightWorkspaceProvider,
} from "./PlaywrightWorkspace.ts";

export const resources = [LoadTest, PlaywrightWorkspace];
export const layers = () =>
  Layer.mergeAll(LoadTestProvider(), PlaywrightWorkspaceProvider());
