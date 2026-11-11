import type { Resource } from "alchemy/Resource";

/** The env var a scheduled job's container runs with: the job's name. */
export const JOB_ENV = "ALCHEMY_DO_JOB";

/** A scheduled job a cron binding attaches to its App. */
export interface AppJob {
  readonly name: string;
  readonly cron: string;
  readonly timeZone?: string;
}

/** What a binding attaches to an App: environment variables and scheduled jobs. */
export interface AppBinding {
  env?: Record<string, any>;
  jobs?: ReadonlyArray<AppJob>;
}

export const isAppHost = (value: unknown): value is Resource<string, any, any, AppBinding> =>
  typeof value === "object" &&
  value !== null &&
  (value as { Type?: string }).Type === "DigitalOcean.App";
