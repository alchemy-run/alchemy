import { handleApiError } from "./api-error.ts";
import {
  createCloudflareApi,
  type CloudflareApi,
  type CloudflareApiOptions,
} from "./api.ts";

export interface HyperdriveRefProps extends CloudflareApiOptions {
  name?: string;
  id?: string;
}

export type HyperdriveRef = {
  type: "hyperdrive";
  name: string;
  hyperdriveId: string;
};

export async function HyperdriveRef(
  props: HyperdriveRefProps,
): Promise<HyperdriveRef> {
  const api = await createCloudflareApi(props);

  let hyperdriveId = props.id;
  let hyperdriveName = props.name;

  if (!hyperdriveId && hyperdriveName) {
    // Find hyperdrive by name
    hyperdriveId = await findHyperdriveIdByName(api, hyperdriveName);
    if (!hyperdriveId) {
      throw new Error(
        `Hyperdrive config with name "${hyperdriveName}" not found`,
      );
    }
  } else if (!hyperdriveName && hyperdriveId) {
    throw new Error("HyperdriveRef requires either name or both name and id");
  } else if (!hyperdriveName && !hyperdriveId) {
    throw new Error("HyperdriveRef requires at least a name");
  }

  return {
    type: "hyperdrive",
    name: hyperdriveName!,
    hyperdriveId: hyperdriveId!,
  };
}

/**
 * Find a Hyperdrive configuration by name
 */
export async function findHyperdriveIdByName(
  api: CloudflareApi,
  name: string,
  page = 1,
): Promise<string | undefined> {
  const response = await api.get(
    `/accounts/${api.accountId}/hyperdrive/configs?page=${page}`,
  );

  if (!response.ok) {
    await handleApiError(response, "list", "hyperdrive", "all");
  }

  const data: {
    result: Array<{
      id: string;
      name: string;
    }>;
    result_info?: { total_pages?: number };
  } = await response.json();

  const found = data.result.find((config) => config.name === name);
  if (found) {
    return found.id;
  }

  if (data.result_info?.total_pages && page < data.result_info.total_pages) {
    return await findHyperdriveIdByName(api, name, page + 1);
  }

  return undefined;
}
