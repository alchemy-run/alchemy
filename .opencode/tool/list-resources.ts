import { tool } from "@opencode-ai/plugin";
import { getAllProviderDocs } from "./terraform-registry.ts";

const S = tool.schema;

export default tool({
  description:
    "List AWS resources for a specific service from infrastructure-as-code provider documentation. Currently supports Terraform AWS provider. Returns resources and data sources for the specified service.",
  args: {
    provider: S.enum(["terraform", "cloudformation", "pulumi"]).describe(
      "The IaC provider to list resources from. Currently only 'terraform' is implemented.",
    ),
    service: S.string().describe(
      "The service name to list resources for (e.g., 'S3', 'EC2', 'Lambda'). Use list-services tool to get available service names.",
    ),
  },
  async execute(args) {
    const { provider, service } = args;

    if (provider === "terraform") {
      const resources = await fetchTerraformResources(service);
      const result = {
        provider: "terraform",
        providerName: "hashicorp/aws",
        service,
        resourceCount: resources.resources.length,
        dataSourceCount: resources.dataSources.length,
        resources: resources.resources,
        dataSources: resources.dataSources,
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

interface ResourceInfo {
  name: string;
  slug: string;
  path: string;
}

interface ServiceResources {
  resources: ResourceInfo[];
  dataSources: ResourceInfo[];
}

async function fetchTerraformResources(
  service: string,
): Promise<ServiceResources> {
  const allDocs = await getAllProviderDocs();

  const resources: ResourceInfo[] = [];
  const dataSources: ResourceInfo[] = [];

  // Build a map of all services for validation
  const allServices = new Map<string, string>();
  for (const doc of allDocs) {
    if (doc.attributes.subcategory) {
      allServices.set(
        doc.attributes.subcategory.toLowerCase(),
        doc.attributes.subcategory,
      );
    }
  }

  // Find matching service (case-insensitive)
  const serviceLower = service.toLowerCase();
  const matchedService = allServices.get(serviceLower);

  if (!matchedService) {
    // Try to find similar services for a helpful error message
    const similarServices = findSimilarServices(serviceLower, allServices);
    let errorMsg = `Service '${service}' not found.`;

    if (similarServices.length > 0) {
      errorMsg += ` Did you mean: ${similarServices.join(", ")}?`;
    } else {
      errorMsg += " Use list-services tool to see available services.";
    }

    throw new Error(errorMsg);
  }

  // Filter docs by the matched service
  for (const doc of allDocs) {
    if (doc.attributes.subcategory !== matchedService) {
      continue;
    }

    const info: ResourceInfo = {
      name: doc.attributes.title,
      slug: doc.attributes.slug,
      path: doc.attributes.path,
    };

    if (doc.attributes.category === "resources") {
      resources.push(info);
    } else if (doc.attributes.category === "data-sources") {
      dataSources.push(info);
    }
  }

  // Sort by name
  resources.sort((a, b) => a.name.localeCompare(b.name));
  dataSources.sort((a, b) => a.name.localeCompare(b.name));

  return { resources, dataSources };
}

function findSimilarServices(
  input: string,
  services: Map<string, string>,
): string[] {
  const results: string[] = [];

  for (const [lowerName, originalName] of services) {
    // Check if input is a prefix or substring
    if (lowerName.startsWith(input) || lowerName.includes(input)) {
      results.push(originalName);
    }
  }

  // Limit to 5 suggestions
  return results.slice(0, 5);
}

if (import.meta.main) {
  const resources = await fetchTerraformResources("S3 (Simple Storage)");
  console.log(JSON.stringify(resources, null, 2));
}
