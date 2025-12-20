import { tool } from "@opencode-ai/plugin";
import {
  getAllProviderDocs,
  TERRAFORM_REGISTRY_V2,
  type ProviderDoc,
} from "./terraform-registry.ts";

const S = tool.schema;

export default tool({
  description:
    "Get the full Terraform documentation for a specific AWS resource. Returns the markdown documentation content including arguments, attributes, and examples.",
  args: {
    provider: S.enum(["terraform", "cloudformation", "pulumi"]).describe(
      "The IaC provider. Currently only 'terraform' is implemented.",
    ),
    resource: S.string().describe(
      "The resource slug/name (e.g., 's3_bucket', 'lambda_function', 'dynamodb_table'). Use list-resources tool to find available resources.",
    ),
    type: S.enum(["resource", "data-source"])
      .optional()
      .describe(
        "Whether to get docs for a resource or data source. Defaults to 'resource'.",
      ),
  },
  async execute(args) {
    const { provider, resource, type = "resource" } = args;

    if (provider === "terraform") {
      const docs = await getTerraformResourceDocs(
        resource,
        type === "resource" ? "resources" : "data-sources",
      );
      return docs;
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

interface ResourceDocsResponse {
  data: {
    type: string;
    id: string;
    attributes: {
      category: string;
      content: string;
      language: string;
      path: string;
      slug: string;
      subcategory: string;
      title: string;
      truncated: boolean;
    };
  };
}

async function getTerraformResourceDocs(
  resourceSlug: string,
  category: "resources" | "data-sources",
): Promise<string> {
  const allDocs = await getAllProviderDocs();

  // Find the matching doc
  const doc = findMatchingDoc(allDocs, resourceSlug, category);

  if (!doc) {
    const categoryLabel = category === "resources" ? "resource" : "data source";
    const similarResources = findSimilarResources(
      allDocs,
      resourceSlug,
      category,
    );

    let errorMsg = `Could not find ${categoryLabel} '${resourceSlug}'.`;
    if (similarResources.length > 0) {
      errorMsg += ` Did you mean: ${similarResources.join(", ")}?`;
    } else {
      errorMsg += " Use list-resources tool to find available resources.";
    }

    throw new Error(errorMsg);
  }

  // Fetch the full documentation
  const url = `${TERRAFORM_REGISTRY_V2}/provider-docs/${doc.id}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Failed to fetch docs for ${resourceSlug}: ${response.status}`,
    );
  }

  const data: ResourceDocsResponse = await response.json();

  return data.data.attributes.content;
}

function findMatchingDoc(
  docs: ProviderDoc[],
  resourceSlug: string,
  category: "resources" | "data-sources",
): ProviderDoc | undefined {
  const slugLower = resourceSlug.toLowerCase();

  // Try exact match first
  let doc = docs.find(
    (d) =>
      d.attributes.category === category &&
      d.attributes.slug.toLowerCase() === slugLower,
  );

  if (doc) return doc;

  // Try without aws_ prefix
  const withoutPrefix = slugLower.replace(/^aws_/, "");
  doc = docs.find(
    (d) =>
      d.attributes.category === category &&
      d.attributes.slug.toLowerCase() === withoutPrefix,
  );

  if (doc) return doc;

  // Try with aws_ prefix added
  const withPrefix = `aws_${slugLower}`;
  doc = docs.find(
    (d) =>
      d.attributes.category === category &&
      d.attributes.slug.toLowerCase() === withPrefix,
  );

  return doc;
}

function findSimilarResources(
  docs: ProviderDoc[],
  input: string,
  category: "resources" | "data-sources",
): string[] {
  const inputLower = input.toLowerCase().replace(/^aws_/, "");
  const results: string[] = [];

  for (const doc of docs) {
    if (doc.attributes.category !== category) continue;

    const slug = doc.attributes.slug.toLowerCase();
    if (slug.includes(inputLower) || inputLower.includes(slug)) {
      results.push(doc.attributes.slug);
    }
  }

  // Limit to 5 suggestions
  return results.slice(0, 5);
}

if (import.meta.main) {
  const docs = await getTerraformResourceDocs("s3_bucket", "resources");
  console.log(docs);
}
