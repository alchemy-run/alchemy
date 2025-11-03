import { Runtime } from "alchemy-effect";

export const WorkerType = "AWS.Lambda.Worker";
export type WorkerType = typeof WorkerType;

export type WorkerProps = {
  name?: string;
  main: string;
  handler?: string;
  memory?: number;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  compatibility?: "node" | "browser";
  adopt?: boolean;
  observability?: {
    enabled?: boolean;
  };
  url?: boolean;
};

export type WorkerAttr<Props extends WorkerProps = WorkerProps> = {
  url: Props["url"] extends false ? undefined : string;
};

export interface Worker extends Runtime<WorkerType> {
  props: WorkerProps;
  attr: WorkerAttr<Extract<this["props"], WorkerProps>>;
  binding: {
    bindings: {
      [key: string]: any;
    };
  };
}
export const Worker = Runtime(WorkerType)<Worker>();
