import type { Workers } from "cloudflare/resources";
import { Runtime, type RuntimeProps } from "../../runtime.ts";
import type * as Assets from "./assets.fetch.ts";

export const WorkerType = "Cloudflare.Worker" as const;
export type WorkerType = typeof WorkerType;

export type WorkerProps<Req = any> = RuntimeProps<
  Worker,
  Exclude<Req, Assets.Fetch>
> & {
  name?: string;
  logpush?: boolean;
  observability?: Worker.Observability;
  subdomain?: Worker.Subdomain;
  tags?: string[];
  main: string;
  compatibility?: {
    date?: string;
    flags?: string[];
  };
  limits?: Worker.Limits;
  placement?: Worker.Placement;
} & (Extract<Req, Assets.Fetch> extends never
    ? {
        assets?: string | Worker.AssetsProps;
      }
    : {
        assets: string | Worker.AssetsProps;
      });

export type WorkerAttr<Props extends WorkerProps> = {
  id: string;
  name: Props["name"] extends string ? Props["name"] : string;
  logpush: Props["logpush"] extends boolean ? Props["logpush"] : boolean;
  observability: Props["observability"] extends Worker.Observability
    ? Props["observability"]
    : {
        // whatever cloudflare's (or our, probably ours) default is
      };
  url: Props["subdomain"] extends { enabled: false } ? undefined : string;
  subdomain: Props["subdomain"] extends Worker.Subdomain
    ? Props["subdomain"]
    : { enabled: true; previews_enabled: true };
  tags: Props["tags"] extends string[] ? Props["tags"] : string[];
  accountId: string;
  hash: { assets: string | undefined; bundle: string };
};

export interface Worker extends Runtime<WorkerType> {
  props: WorkerProps;
  attr: WorkerAttr<Extract<this["props"], WorkerProps>>;
  binding: {
    bindings: Worker.Binding[];
  };
}

export const Worker = Runtime(WorkerType)<Worker>();

export declare namespace Worker {
  export type Observability = Workers.ScriptUpdateParams.Metadata.Observability;
  export type Subdomain = Workers.Beta.Worker.Subdomain;
  export type Binding = NonNullable<
    Workers.Beta.Workers.VersionCreateParams["bindings"]
  >[number];
  export type Limits = Workers.Beta.Workers.Version.Limits;
  export type Placement = Workers.Beta.Workers.Version.Placement;
  export type Assets = Workers.Beta.Workers.Version.Assets;
  export type AssetsConfig = Workers.Beta.Workers.Version.Assets.Config;
  export type Module = Workers.Beta.Workers.Version.Module;

  export interface AssetsProps {
    directory: string;
    config?: AssetsConfig;
  }
}
