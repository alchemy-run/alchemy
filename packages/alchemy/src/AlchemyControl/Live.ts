import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AlchemyControl,
  type AlchemyControlService,
} from "./AlchemyControl.ts";
import { AwsControl, AwsControlLive } from "./AwsControl.ts";
import {
  CloudflareControl,
  CloudflareControlLive,
} from "./CloudflareControl.ts";
import {
  CloudflareTokenControl,
  CloudflareTokenControlLive,
} from "./CloudflareTokenControl.ts";
import { DriftControl, DriftControlLive } from "./DriftControl.ts";
import { LogControl, LogControlLive } from "./LogControl.ts";
import { NukeControl, NukeControlLive } from "./NukeControl.ts";
import { ProfileControl, ProfileControlLive } from "./ProfileControl.ts";
import { ProviderControl, ProviderControlLive } from "./ProviderControl.ts";
import { StackControl, StackControlLive } from "./StackLifecycle.ts";
import { StateControl, StateControlLive } from "./StateControl.ts";

const operationCapabilities = Layer.mergeAll(
  DriftControlLive,
  NukeControlLive,
  ProfileControlLive,
  StackControlLive,
);

/** Live implementations for every independently consumable control capability. */
export const capabilities = Layer.mergeAll(
  AwsControlLive,
  CloudflareControlLive,
  CloudflareTokenControlLive,
  LogControlLive,
  operationCapabilities,
  ProviderControlLive,
  StateControlLive,
);

const makeFacade = Effect.gen(function* () {
  const {
    aws,
    cloudflare,
    token,
    drift,
    logs,
    nuke,
    profile,
    provider,
    stack,
    state,
  } = yield* Effect.all({
    aws: AwsControl,
    cloudflare: CloudflareControl,
    token: CloudflareTokenControl,
    drift: DriftControl,
    logs: LogControl,
    nuke: NukeControl,
    profile: ProfileControl,
    provider: ProviderControl,
    stack: StackControl,
    state: StateControl,
  });
  return {
    stack,
    drift,
    logs,
    state,
    profile,
    provider: {
      checkEnvironment: provider.checkEnvironment,
      aws,
      cloudflare: {
        ...cloudflare,
        token,
      },
    },
    unsafe: { nuke },
  } satisfies AlchemyControlService;
});

const facade = Layer.effect(AlchemyControl, makeFacade);

/** Capability services plus the compatibility aggregate facade. */
export const layer = Layer.mergeAll(
  capabilities,
  Layer.provide(facade, capabilities),
);
