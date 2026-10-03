import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import { DataSet, DataSetProvider } from "./DataSet.ts";
import { DataSetMapping, DataSetMappingProvider } from "./DataSetMapping.ts";
import { Invitation, InvitationProvider } from "./Invitation.ts";
import { Share, ShareProvider } from "./Share.ts";
import {
  ShareSubscription,
  ShareSubscriptionProvider,
} from "./ShareSubscription.ts";
import {
  SynchronizationSetting,
  SynchronizationSettingProvider,
} from "./SynchronizationSetting.ts";
import { Trigger, TriggerProvider } from "./Trigger.ts";

export const resources = [
  Account,
  DataSet,
  DataSetMapping,
  Invitation,
  Share,
  ShareSubscription,
  SynchronizationSetting,
  Trigger,
];
export const layers = () =>
  Layer.mergeAll(
    AccountProvider(),
    DataSetProvider(),
    DataSetMappingProvider(),
    InvitationProvider(),
    ShareProvider(),
    ShareSubscriptionProvider(),
    SynchronizationSettingProvider(),
    TriggerProvider(),
  );
