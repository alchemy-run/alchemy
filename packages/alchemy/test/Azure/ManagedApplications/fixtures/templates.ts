/** Built-in Reader role definition GUID. */
export const READER = "acdd72a7-3385-48ef-bd42-f606fba81ae7";

/** Empty template that echoes its `greeting` parameter as an output. */
export const mainTemplate = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  parameters: {
    greeting: { type: "string", defaultValue: "hi" },
  },
  resources: [],
  outputs: {
    greeting: { type: "string", value: "[parameters('greeting')]" },
  },
};

export const createUiDefinition = {
  $schema:
    "https://schema.management.azure.com/schemas/0.1.2-preview/CreateUIDefinition.MultiVm.json#",
  handler: "Microsoft.Azure.CreateUIDef",
  version: "0.1.2-preview",
  parameters: { basics: [], steps: [], outputs: {} },
};
