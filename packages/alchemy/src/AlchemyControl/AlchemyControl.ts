import * as Context from "effect/Context";
import type { AwsControl } from "./AwsControl.ts";
import type { CloudflareControl } from "./CloudflareControl.ts";
import type { CloudflareTokenControl } from "./CloudflareTokenControl.ts";
import type { DriftControl } from "./DriftControl.ts";
import type { LogControl } from "./LogControl.ts";
import type { NukeControl } from "./NukeControl.ts";
import type { ProfileControl } from "./ProfileControl.ts";
import type { ProviderControl } from "./ProviderControl.ts";
import type { StackControl } from "./StackLifecycle.ts";
import type { StateControl } from "./StateControl.ts";

/**
 * Presentation-independent aggregate of the module-owned control surfaces.
 * Each top-level module remains the sole owner of its leaf routes.
 */
export interface AlchemyControlService {
  readonly stack: StackControl["Service"];
  readonly drift: DriftControl["Service"];
  readonly logs: LogControl["Service"];
  readonly state: StateControl["Service"];
  readonly profile: ProfileControl["Service"];
  readonly provider: ProviderControl["Service"] & {
    readonly aws: AwsControl["Service"];
    readonly cloudflare: CloudflareControl["Service"] & {
      readonly token: CloudflareTokenControl["Service"];
    };
  };
  readonly unsafe: { readonly nuke: NukeControl["Service"] };
}

export class AlchemyControl extends Context.Service<
  AlchemyControl,
  AlchemyControlService
>()("alchemy/AlchemyControl") {}
