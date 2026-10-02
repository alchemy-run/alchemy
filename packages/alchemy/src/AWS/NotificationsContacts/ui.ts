import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { EmailContact } from "./EmailContact.ts";

/**
 * Dashboard UI providers for AWS NotificationsContacts resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const EmailContactUI = UIProvider.succeed<EmailContact>(
  "AWS.NotificationsContacts.EmailContact",
  {
    displayName: "Notifications Email Contact",
    icon: "mail",
    color: "#E7157B",
    category: "email",
    summary: (ctx) => ctx.attrs?.emailAddress ?? ctx.attrs?.name,
    facts: (ctx) => [
      { label: "name", value: ctx.attrs?.name, copy: true },
      { label: "email", value: ctx.attrs?.emailAddress, copy: true },
      {
        label: "arn",
        value: ctx.attrs?.emailContactArn,
        mono: true,
        copy: true,
      },
      { label: "status", value: ctx.attrs?.status },
    ],
  },
);

export const ui = () => Layer.mergeAll(EmailContactUI);
