interface DeploymentResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

const isCloudflareHtml = (response: DeploymentResponse): boolean =>
  response.headers.server === "cloudflare" &&
  /^text\/html(?:;|$)/i.test(response.headers["content-type"] ?? "") &&
  /^[a-f0-9]{16,32}(?:-[A-Z0-9]+)?$/i.test(response.headers["cf-ray"] ?? "");

// These fixtures never return or proxy Cloudflare's native missing-script page.
export const isScriptNotFound = (
  response: DeploymentResponse,
  body: string,
  url: string,
): boolean =>
  response.status === 500 &&
  isCloudflareHtml(response) &&
  body.includes(
    `<title>Script not found | ${new URL(url).hostname} | Cloudflare</title>`,
  ) &&
  /<span class="cf-error-code">\s*1104\s*<\/span>/.test(body) &&
  body.includes("The script used to render this page could not be found.");

// The workers.dev placeholder has no hostname in its body.
export const isWorkersDevNotFound = (
  response: DeploymentResponse,
  body: string,
  url: string,
): boolean => {
  const target = new URL(url);
  return (
    response.status === 404 &&
    target.protocol === "https:" &&
    target.hostname.endsWith(".workers.dev") &&
    isCloudflareHtml(response) &&
    body.includes("<title>Page not found</title>") &&
    body.includes('<meta http-equiv="refresh" content="30">') &&
    body.includes('href="https://workers.cloudflare.com/favicon.ico"') &&
    body.includes("<h1>There is nothing here yet</h1>") &&
    body.includes(
      "If you expect something to be here, it may take some time.<br/>Please check back again later.",
    )
  );
};
