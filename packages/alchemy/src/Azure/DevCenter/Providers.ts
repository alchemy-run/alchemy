import * as Layer from "effect/Layer";
import { DevCenter, DevCenterProvider } from "./DevCenter.ts";
import { Project, ProjectProvider } from "./Project.ts";

export const resources = [DevCenter, Project];
export const layers = () =>
  Layer.mergeAll(DevCenterProvider(), ProjectProvider());
