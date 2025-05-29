import type { Resource } from "../resource.ts";

export interface RuntimeState {
  get(id: string): Resource;
}

// /**
//  * Runtime state injected into the environment.
//  */
