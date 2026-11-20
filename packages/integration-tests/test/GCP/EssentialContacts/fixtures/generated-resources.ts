import * as GCP from "@alchemy.run/gcp";

/** EssentialContacts resources the generated bindings bind, mirroring each resource suite's smallest shape. */

export const ProbeContact = GCP.EssentialContacts.Contact("ProbeContact", {
  email: "ops@example.com",
  languageTag: "en-US",
  notificationCategorySubscriptions: ["ALL"],
});
