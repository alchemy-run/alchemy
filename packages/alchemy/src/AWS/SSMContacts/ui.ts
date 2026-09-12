import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { Contact } from "./Contact.ts";
import type { ContactChannel } from "./ContactChannel.ts";
import type { Plan } from "./Plan.ts";
import type { Rotation } from "./Rotation.ts";

/**
 * Dashboard UI providers for AWS SSM Contacts resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** SSM Contacts brand color (AWS Management & Governance pink). */
const SSM_CONTACTS_COLOR = "#E7157B";

export const ContactUI = UIProvider.succeed<Contact>(
  "AWS.SSMContacts.Contact",
  {
    displayName: "Incident Manager Contact",
    icon: "phone",
    color: SSM_CONTACTS_COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.displayName ?? ctx.attrs?.alias,
    facts: (ctx) => [
      { label: "alias", value: ctx.attrs?.alias, copy: true },
      { label: "arn", value: ctx.attrs?.contactArn, mono: true, copy: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "display name", value: ctx.attrs?.displayName },
    ],
  },
);

export const ContactChannelUI = UIProvider.succeed<ContactChannel>(
  "AWS.SSMContacts.ContactChannel",
  {
    displayName: "Incident Manager Contact Channel",
    icon: "send",
    color: SSM_CONTACTS_COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "channel", value: ctx.attrs?.name, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.contactChannelArn,
        mono: true,
        copy: true,
      },
      { label: "contact", value: ctx.attrs?.contactArn, mono: true },
      { label: "type", value: ctx.attrs?.type },
      { label: "activation", value: ctx.attrs?.activationStatus },
    ],
  },
);

export const PlanUI = UIProvider.succeed<Plan>("AWS.SSMContacts.Plan", {
  displayName: "Incident Manager Engagement Plan",
  icon: "list-ordered",
  color: SSM_CONTACTS_COLOR,
  category: "observability",
  summary: (ctx) => ctx.attrs?.contactArn,
  facts: (ctx) => [
    { label: "contact", value: ctx.attrs?.contactArn, mono: true, copy: true },
    { label: "stages", value: ctx.attrs?.stageCount },
  ],
});

export const RotationUI = UIProvider.succeed<Rotation>(
  "AWS.SSMContacts.Rotation",
  {
    displayName: "Incident Manager Rotation",
    icon: "repeat",
    color: SSM_CONTACTS_COLOR,
    category: "observability",
    summary: (ctx) => ctx.attrs?.name,
    facts: (ctx) => [
      { label: "rotation", value: ctx.attrs?.name, copy: true },
      { label: "arn", value: ctx.attrs?.rotationArn, mono: true, copy: true },
      { label: "start time", value: ctx.attrs?.startTime },
      { label: "time zone", value: ctx.props?.timeZoneId },
      { label: "contacts", value: ctx.props?.contactIds?.length },
    ],
  },
);

export const ui = () =>
  Layer.mergeAll(ContactUI, ContactChannelUI, PlanUI, RotationUI);
