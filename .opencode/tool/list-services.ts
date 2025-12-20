import { tool } from "@opencode-ai/plugin";
import { getAllProviderDocs } from "./terraform-registry.ts";

const S = tool.schema;

export default tool({
  description:
    "List AWS service names from infrastructure-as-code provider documentation. Currently supports Terraform AWS provider. Returns a sorted list of unique service/subcategory names.",
  args: {
    provider: S.enum(["terraform", "cloudformation", "pulumi"]).describe(
      "The IaC provider to list services from. Currently only 'terraform' is implemented.",
    ),
  },
  async execute(args) {
    const { provider } = args;

    if (provider === "terraform") {
      const services = await fetchTerraformServices();
      const result = {
        provider: "terraform",
        providerName: "hashicorp/aws",
        serviceCount: services.length,
        services,
      };
      return JSON.stringify(result, null, 2);
    } else if (provider === "cloudformation") {
      throw new Error(
        "CloudFormation provider not yet implemented. Please use 'terraform' for now.",
      );
    } else if (provider === "pulumi") {
      throw new Error(
        "Pulumi provider not yet implemented. Please use 'terraform' for now.",
      );
    } else {
      throw new Error(`Unknown provider: ${provider}`);
    }
  },
});

async function fetchTerraformServices(): Promise<string[]> {
  const allDocs = await getAllProviderDocs();

  const services = new Set<string>();
  for (const doc of allDocs) {
    if (doc.attributes.subcategory) {
      services.add(doc.attributes.subcategory);
    }
  }

  return Array.from(services).sort();
}
