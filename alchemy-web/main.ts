const recordTypes = ["A", "AAAA", "MX", "TXT", "NS", "CNAME", "SOA", "SRV"];

export async function fetchDNSRecords(domain: string) {
  const results: Record<string, any[]> = {};

  for (const type of recordTypes) {
    try {
      const res = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${domain}&type=${type}`,
        {
          headers: {
            accept: "application/dns-json",
          },
        },
      );

      const data = await res.json();

      if (data.Answer) {
        results[type] = data.Answer;
      }
    } catch (error) {
      console.warn(`Failed to fetch ${type} records for ${domain}:`, error);
    }
  }

  return results;
}

// Example usage (top-level await supported in Bun)
console.log(await fetchDNSRecords("alchemy.run"));
