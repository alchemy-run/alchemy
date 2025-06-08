import type { Phase } from "../../alchemy.ts";

export namespace Telemetry {
  export interface Context {
    /** Random UUID generated once per machine and stored in XDG config directory (e.g. `~/Library/Preferences/alchemy` on Mac). Null for CI environments. */
    userId: string | null;
    /** Root commit hash for the git repository. Anonymous, stable identifier for anyone using git. */
    projectId: string | null;
    /** UUID generated once per application run. */
    sessionId: string;

    system: {
      platform: string;
      osVersion: string;
      arch: string;
      cpus: number;
      memory: number;
    };

    runtime: {
      name: string | null;
      version: string | null;
    };

    environment: {
      provider: string | null;
      isCI: boolean;
    };

    alchemy: {
      version: string;
      phase: Phase;
    };
  }

  export interface BaseEvent {
    event: string;
    context: Context;
    timestamp: number;
  }

  export interface SerializedError {
    name?: string;
    message: string;
    stack?: string;
  }

  export type ErrorInput = Error | SerializedError;

  export interface AppEvent extends BaseEvent {
    event: "app.start" | "app.success" | "app.error";
    elapsed?: number;
    error?: SerializedError;
  }

  export interface ResourceEvent extends BaseEvent {
    event:
      | "resource.start"
      | "resource.success"
      | "resource.error"
      | "resource.skip"
      | "resource.read";
    resource: string;
    status?:
      | "creating"
      | "created"
      | "updating"
      | "updated"
      | "deleting"
      | "deleted";
    elapsed?: number;
    error?: SerializedError;
    replaced?: boolean;
  }

  export type Event = AppEvent | ResourceEvent;
  export type EventInput = (
    | Omit<AppEvent, "context" | "timestamp" | "error">
    | Omit<ResourceEvent, "context" | "timestamp" | "error">
  ) & {
    error?: ErrorInput;
  };
}
