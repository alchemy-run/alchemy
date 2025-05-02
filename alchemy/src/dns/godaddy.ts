export type UpdateNameserversOptions = {
  domain: string;
  apiKey: string;
  apiSecret: string;
  nameservers: string[];
};

export async function updateNameservers(options: UpdateNameserversOptions) {
  const url = `https://api.godaddy.com/v1/domains/${options.domain}/nameservers`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `sso-key ${options.apiKey}:${options.apiSecret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      nameservers: options.nameservers,
    }),
  });

  if (response.ok) {
    console.log(`✅ Nameservers updated for ${options.domain}`);
  } else {
    const error = await response.json();
    console.error("❌ Failed to update nameservers:", error);
  }
}
