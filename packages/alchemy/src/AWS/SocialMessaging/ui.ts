import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { LinkedWhatsAppBusinessAccount } from "./LinkedWhatsAppBusinessAccount.ts";

/**
 * Dashboard UI providers for AWS SocialMessaging resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

/** AWS App Integration (End User Messaging Social) brand pink. */
const COLOR = "#E7157B";

export const LinkedWhatsAppBusinessAccountUI =
  UIProvider.succeed<LinkedWhatsAppBusinessAccount>(
    "AWS.SocialMessaging.LinkedWhatsAppBusinessAccount",
    {
      displayName: "Linked WhatsApp Business Account",
      icon: "phone",
      color: COLOR,
      category: "eventing",
      summary: (ctx) => ctx.attrs?.wabaName,
      facts: (ctx) => [
        { label: "waba name", value: ctx.attrs?.wabaName, copy: true },
        { label: "id", value: ctx.attrs?.id, mono: true, copy: true },
        { label: "arn", value: ctx.attrs?.arn, mono: true, copy: true },
        { label: "waba id", value: ctx.attrs?.wabaId, mono: true },
        { label: "registration", value: ctx.attrs?.registrationStatus },
        { label: "phone numbers", value: ctx.attrs?.phoneNumbers?.length },
      ],
    },
  );

export const ui = () => Layer.mergeAll(LinkedWhatsAppBusinessAccountUI);
