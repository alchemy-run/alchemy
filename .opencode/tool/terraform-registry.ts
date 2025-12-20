import fs from "node:fs/promises";

const CACHE_DIR = ".cache";

export async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

export async function getTerraformAWSProviderVersionId(): Promise<string> {
  await ensureCacheDir();

  const versionCacheFile = `${CACHE_DIR}/terraform-aws-version-id.json`;

  if (await fs.exists(versionCacheFile)) {
    const cached = JSON.parse(await fs.readFile(versionCacheFile, "utf-8"));
    // Cache for 24 hours
    if (Date.now() - cached.timestamp < 24 * 60 * 60 * 1000) {
      return cached.versionId;
    }
  }

  const response = await fetch(
    "https://registry.terraform.io/v2/providers/hashicorp/aws?include=provider-versions",
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch provider info: ${response.status}`);
  }

  const data = await response.json();
  const versions = data.data.relationships["provider-versions"].data;
  const latestVersionId = versions.reduce(
    (max: { id: string }, v: { id: string }) =>
      parseInt(v.id) > parseInt(max.id) ? v : max,
    versions[0],
  ).id;

  await fs.writeFile(
    versionCacheFile,
    JSON.stringify(
      { versionId: latestVersionId, timestamp: Date.now() },
      null,
      2,
    ),
  );

  return latestVersionId;
}

export interface ProviderDoc {
  type: string;
  id: string;
  attributes: {
    category: string;
    language: string;
    path: string;
    slug: string;
    subcategory: string;
    title: string;
    truncated: boolean;
  };
}

export interface TerraformDocsResponse {
  data: ProviderDoc[];
}

export const TERRAFORM_REGISTRY_V2 = "https://registry.terraform.io/v2";

/**
 * Fetches all provider docs and caches them. Returns the full list of docs.
 * This is used by both list-services and list-resources to avoid redundant API calls.
 */
export async function getAllProviderDocs(): Promise<ProviderDoc[]> {
  await ensureCacheDir();

  const cacheFile = `${CACHE_DIR}/terraform-provider-docs.json`;

  if (await fs.exists(cacheFile)) {
    return JSON.parse(await fs.readFile(cacheFile, "utf-8"));
  }

  const versionId = await getTerraformAWSProviderVersionId();
  const allDocs: ProviderDoc[] = [];
  let page = 1;
  // API caps page size at 100
  const pageSize = 100;

  while (true) {
    const url = `${TERRAFORM_REGISTRY_V2}/provider-docs?filter[provider-version]=${versionId}&page[size]=${pageSize}&page[number]=${page}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch docs page ${page}: ${response.status}`);
    }

    const data: TerraformDocsResponse = await response.json();

    // Stop when we get an empty page
    if (data.data.length === 0) {
      break;
    }

    allDocs.push(...data.data);
    page++;

    // Safety limit
    if (page > 100) {
      break;
    }
  }

  await fs.writeFile(cacheFile, JSON.stringify(allDocs, null, 2));
  return allDocs;
}
