import type { Resource } from "../resource.js";

export interface RuntimeState {
  get(id: string): Resource;
}

// /**
//  * Runtime state injected into the environment.
//  */
