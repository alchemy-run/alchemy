import * as Layer from "effect/Layer";
import { Gateway, GatewayProvider } from "./Gateway.ts";
import { License, LicenseProvider } from "./License.ts";
import { LicenseProfile, LicenseProfileProvider } from "./LicenseProfile.ts";
import { Machine, MachineProvider } from "./Machine.ts";
import {
  MachineExtension,
  MachineExtensionProvider,
} from "./MachineExtension.ts";
import {
  MachineRunCommand,
  MachineRunCommandProvider,
} from "./MachineRunCommand.ts";
import {
  PrivateLinkScope,
  PrivateLinkScopeProvider,
} from "./PrivateLinkScope.ts";
import { Settings, SettingsProvider } from "./Settings.ts";

export const resources = [
  Gateway,
  License,
  LicenseProfile,
  Machine,
  MachineExtension,
  MachineRunCommand,
  PrivateLinkScope,
  Settings,
];
export const layers = () =>
  Layer.mergeAll(
    GatewayProvider(),
    LicenseProvider(),
    LicenseProfileProvider(),
    MachineProvider(),
    MachineExtensionProvider(),
    MachineRunCommandProvider(),
    PrivateLinkScopeProvider(),
    SettingsProvider(),
  );
