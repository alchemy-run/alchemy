import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ConfigurationSet } from "./ConfigurationSet.ts";
import type { EventDestination } from "./EventDestination.ts";
import type { OptOutList } from "./OptOutList.ts";
import type { PhoneNumber } from "./PhoneNumber.ts";

/**
 * Dashboard UI providers for AWS PinpointSMSVoiceV2 resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS app integration / messaging brand pink. */
const COLOR = "#E7157B";

export const ConfigurationSetUI = UIProvider.succeed<ConfigurationSet>(
  "AWS.PinpointSMSVoiceV2.ConfigurationSet",
  {
    displayName: "SMS Configuration Set",
    icon: "settings",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.configurationSetName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.configurationSetName, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.configurationSetArn,
        mono: true,
        copy: true,
      },
    ],
  },
);

export const EventDestinationUI = UIProvider.succeed<EventDestination>(
  "AWS.PinpointSMSVoiceV2.EventDestination",
  {
    displayName: "SMS Event Destination",
    icon: "webhook",
    color: COLOR,
    category: "eventing",
    summary: (ctx) => ctx.attrs?.eventDestinationName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.eventDestinationName, copy: true },
      { label: "configuration set", value: ctx.attrs?.configurationSetName },
      { label: "enabled", value: ctx.attrs?.enabled },
      {
        label: "event types",
        value: ctx.attrs?.matchingEventTypes?.join(", "),
      },
    ],
  },
);

export const OptOutListUI = UIProvider.succeed<OptOutList>(
  "AWS.PinpointSMSVoiceV2.OptOutList",
  {
    displayName: "SMS Opt-Out List",
    icon: "list-ordered",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.optOutListName,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.optOutListName, copy: true },
      { label: "arn", value: ctx.attrs?.optOutListArn, mono: true, copy: true },
    ],
  },
);

export const PhoneNumberUI = UIProvider.succeed<PhoneNumber>(
  "AWS.PinpointSMSVoiceV2.PhoneNumber",
  {
    displayName: "SMS Phone Number",
    icon: "phone",
    color: COLOR,
    category: "other",
    summary: (ctx) => ctx.attrs?.phoneNumber,
    facts: (ctx) => [
      { label: "number", value: ctx.attrs?.phoneNumber, copy: true },
      { label: "id", value: ctx.attrs?.phoneNumberId, mono: true, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.phoneNumberArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
      { label: "country", value: ctx.attrs?.isoCountryCode },
      { label: "type", value: ctx.attrs?.numberType },
      {
        label: "capabilities",
        value: ctx.attrs?.numberCapabilities?.join(", "),
      },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(
    ConfigurationSetUI,
    EventDestinationUI,
    OptOutListUI,
    PhoneNumberUI,
  );
