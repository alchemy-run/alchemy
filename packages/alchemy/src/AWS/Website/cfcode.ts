// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * CloudFront Function injection code ported from SST's Router component.
 * These are JavaScript code strings that get injected into CloudFront Function handlers.
 *
 * The target runtime is cloudfront-js-2.0, which validates syntax at deploy
 * time and supports only: ES5.1 statements, `const`/`let`, `async`/`await`,
 * arrow functions, template literals, rest parameters, and modern
 * Array/Object/String prototype methods. It does NOT support `for-of`,
 * classes, spread, or destructuring — never emit those in generated code.
 */

/**
 * Host-based 301 handling injected at the very top of a generated
 * viewer-request handler (before route matching). Redirects requests whose
 * `Host` is one of the configured redirect hostnames — and, when
 * `cloudfrontUrl: false`, requests arriving via the distribution's default
 * `*.cloudfront.net` domain (the default domain is not knowable inside its
 * own function config before the distribution exists, but only requests
 * served via the default domain ever carry a `.cloudfront.net` Host;
 * alternate domain names never do) — to the canonical hostname with path
 * and query preserved.
 *
 * Relies on `buildHostRedirectResponse` declared by
 * {@link CF_ROUTER_INJECTION} (function declarations hoist within the
 * handler). Returns an empty string when there is nothing to redirect.
 */
export const buildHostRedirectInjection = ({
  to,
  hosts,
  cloudfrontDefault,
}: {
  /** Canonical hostname redirected to. */
  to: string | undefined;
  /** Exact redirect hostnames. */
  hosts: string[];
  /** Also redirect the distribution's default `*.cloudfront.net` domain. */
  cloudfrontDefault: boolean;
}): string => {
  if (!to || (hosts.length === 0 && !cloudfrontDefault)) return "";
  const conditions = [
    ...(hosts.length > 0
      ? [`${JSON.stringify(hosts)}.includes(redirectHost)`]
      : []),
    ...(cloudfrontDefault ? [`redirectHost.endsWith(".cloudfront.net")`] : []),
  ];
  return `
  const redirectHost = event.request.headers.host.value;
  if (${conditions.join(" || ")}) {
    return buildHostRedirectResponse(${JSON.stringify(to)});
  }`;
};

const CLOUDFRONT_FUNCTION_SAFE_HEADER_LIMIT = 10240 - 512;

/**
 * Compact generated CloudFront Function code to stay under the service's
 * 10 KB code limit: drop whole-line `//` comments, leading indentation,
 * and repeated blank lines. Safe for this code by construction — the
 * generated code deliberately contains no multiline template literals
 * (all string building uses concatenation), so no generated or
 * user-injected line carries semantic leading whitespace, and only lines
 * that START with `//` are dropped (string contents like "https://…" are
 * untouched), making line-by-line trimming semantics-preserving. A
 * general-purpose minifier is deliberately NOT used here: the
 * cloudfront-js-2.0 runtime validates syntax at deploy time and rejects
 * anything outside its supported feature set, so the artifact must stay
 * hand-auditable against that feature list rather than pass through a
 * rewriter that could emit unsupported constructs.
 */
export const compactCloudFrontFunctionCode = (code: string): string =>
  code
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .map((line) => line.trim())
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");

export const CF_ROUTER_INJECTION = `
async function routeSite(kvNamespace, metadata) {
  if (metadata.redirect && metadata.redirect.hosts.includes(event.request.headers.host.value)) {
    return buildHostRedirectResponse(metadata.redirect.to);
  }

  const baselessUri = metadata.base
    ? event.request.uri.replace(metadata.base, "")
    : event.request.uri;

  // the effect claim — the URL space an effectful Website's fetch handler
  // owns. Checked BEFORE the static-asset manifest lookup so a static
  // file can never shadow an API path (the AWS analogue of Cloudflare's
  // runWorkerFirst), and so /api/* reaches the server even under spa mode.
  if (metadata.serverRoutes && metadata.servers && matchesServerRoute(baselessUri, metadata.serverRoutes)) {
    setForwardedHost();
    encodeSlashedQuerystringKeys();
    if (isRequestHeaderTooLarge()) return buildOversizedHeadersResponse();
    setUrlOrigin(findNearestServer(metadata.servers), metadata.origin);
    return;
  }

  try {
    const u = decodeURIComponent(baselessUri);
    const postfixes = u.endsWith("/")
      ? ["index.html"]
      : ["", ".html", "/index.html"];
    const v = await Promise.any(postfixes.map((p) => cf.kvs().get(kvNamespace + ":" + u + p).then(() => p)));
    event.request.uri = metadata.s3.dir + event.request.uri + v;
    setS3Origin(metadata.s3.domain);
    return;
  } catch (e) {}

  if (metadata.s3 && metadata.s3.routes && metadata.s3.routes.some((route) => baselessUri.startsWith(route))) {
    event.request.uri = metadata.s3.dir + event.request.uri;
    if (event.request.uri.endsWith("/")) {
      event.request.uri += "index.html";
    } else if (!event.request.uri.split("/").pop().includes(".")) {
      event.request.uri += "/index.html";
    }
    setS3Origin(metadata.s3.domain);
    return;
  }

  if (metadata.custom404 && !metadata.errorResponseCode) {
    event.request.uri = metadata.s3.dir + (metadata.base ? metadata.base : "") + metadata.custom404;
    setS3Origin(metadata.s3.domain);
    return;
  }

  if (metadata.s3 && (!metadata.servers || metadata.serverRoutesOnly)) {
    event.request.uri = metadata.s3.dir + event.request.uri;
    setS3Origin(metadata.s3.domain);
    return;
  }

  if (metadata.image && baselessUri.startsWith(metadata.image.route)) {
    setForwardedHost();
    if (isRequestHeaderTooLarge()) return buildOversizedHeadersResponse();
    setUrlOrigin(metadata.image.host, metadata.image.originAccessControlConfig ? { originAccessControlConfig: metadata.image.originAccessControlConfig } : undefined);
    return;
  }

  if (metadata.servers && !metadata.serverRoutesOnly) {
    setForwardedHost();
    encodeSlashedQuerystringKeys();
    if (isRequestHeaderTooLarge()) return buildOversizedHeadersResponse();
    setUrlOrigin(findNearestServer(metadata.servers), metadata.origin);
  }

  function encodeSlashedQuerystringKeys() {
    Object.keys(event.request.querystring).forEach((key) => {
      if (key.includes("/")) {
        event.request.querystring[encodeURIComponent(key)] = event.request.querystring[key];
        delete event.request.querystring[key];
      }
    });
  }

  function matchesServerRoute(uri, routes) {
    if (routes.exclude.some((r) => new RegExp(r).test(uri))) return false;
    return routes.include.some((r) => new RegExp(r).test(uri));
  }

  function findNearestServer(servers) {
    if (servers.length === 1) return servers[0][0];
    const h = event.request.headers;
    const lat = h["cloudfront-viewer-latitude"] && h["cloudfront-viewer-latitude"].value;
    const lon = h["cloudfront-viewer-longitude"] && h["cloudfront-viewer-longitude"].value;
    if (!lat || !lon) return servers[0][0];
    return servers.map((s) => ({ distance: haversineDistance(lat, lon, s[1], s[2]), host: s[0] })).sort((a, b) => a.distance - b.distance)[0].host;
  }

  function haversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (a) => a * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)*Math.sin(dLon/2);
    return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function isRequestHeaderTooLarge() {
    return getRequestHeaderSize() > ${CLOUDFRONT_FUNCTION_SAFE_HEADER_LIMIT};
  }

  function buildOversizedHeadersResponse() {
    return {
      statusCode: 431,
      statusDescription: "Request Header Fields Too Large",
      headers: { "cache-control": { value: "no-store" }, "content-type": { value: "text/plain; charset=utf-8" } },
      body: { encoding: "text", data: "Request headers are too large. Reduce cookie size and try again." },
    };
  }

  function getRequestHeaderSize() {
    let size = 0;
    Object.keys(event.request.headers).forEach((key) => {
      const header = event.request.headers[key];
      if (header.multiValue) {
        header.multiValue.forEach((h) => { size += key.length + h.value.length + 4; });
      } else if (header.value) {
        size += key.length + header.value.length + 4;
      }
    });
    const cookies = [];
    Object.keys(event.request.cookies).forEach((key) => {
      const cookie = event.request.cookies[key];
      if (cookie.multiValue) {
        cookie.multiValue.forEach((c) => { cookies.push(key + "=" + c.value); });
      } else {
        cookies.push(key + "=" + cookie.value);
      }
    });
    if (cookies.length) size += 10 + cookies.join("; ").length;
    return size;
  }
}

function setForwardedHost() {
  event.request.headers["x-forwarded-host"] = event.request.headers.host;
}

function serializeQuerystring() {
  const parts = [];
  Object.keys(event.request.querystring).forEach((key) => {
    const q = event.request.querystring[key];
    if (q.multiValue) {
      q.multiValue.forEach((m) => { parts.push(key + "=" + m.value); });
    } else {
      parts.push(q.value === "" ? key : key + "=" + q.value);
    }
  });
  return parts.length ? "?" + parts.join("&") : "";
}

function buildHostRedirectResponse(toHost) {
  return {
    statusCode: 301,
    statusDescription: "Moved Permanently",
    headers: {
      location: { value: "https://" + toHost + event.request.uri + serializeQuerystring() },
      "cache-control": { value: "no-store" },
    },
  };
}

function setUrlOrigin(urlHost, override) {
  setForwardedHost();
  const origin = {
    domainName: urlHost,
    customOriginConfig: {
      port: 443,
      protocol: "https",
      sslProtocols: ["TLSv1.2"],
    },
    originAccessControlConfig: {
      enabled: false,
    }
  };
  override = override || {};
  if (override.protocol === "http") delete origin.customOriginConfig;
  if (override.connectionAttempts) origin.connectionAttempts = override.connectionAttempts;
  if (override.timeouts) origin.timeouts = override.timeouts;
  if (override.originAccessControlConfig) origin.originAccessControlConfig = override.originAccessControlConfig;
  cf.updateRequestOrigin(origin);
}

function setS3Origin(s3Domain, override) {
  delete event.request.headers["Cookies"];
  delete event.request.headers["cookies"];
  delete event.request.cookies;
  const origin = {
    domainName: s3Domain,
    originAccessControlConfig: {
      enabled: true,
      signingBehavior: "always",
      signingProtocol: "sigv4",
      originType: "s3",
    }
  };
  override = override || {};
  if (override.connectionAttempts) origin.connectionAttempts = override.connectionAttempts;
  if (override.timeouts) origin.timeouts = override.timeouts;
  cf.updateRequestOrigin(origin);
}`;
