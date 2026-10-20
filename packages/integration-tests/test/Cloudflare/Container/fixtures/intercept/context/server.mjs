// Probe server for the outbound-interception test. Plain node, no deps.
// `/probe?url=<url>` fetches <url> from INSIDE the container and reports what
// came back. The container has no internet, so only the owning Durable
// Object's interception can answer.
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";

const CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** GET over HTTPS, trusting the per-instance interception CA when present. */
const getTls = (target) =>
  new Promise((resolve) => {
    const ca = fs.existsSync(CA) ? fs.readFileSync(CA) : undefined;
    https
      .get(target, { ca }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, body }));
      })
      .on("error", (error) => resolve({ error: String(error) }));
  });

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  const url = new URL(req.url, "http://container");
  if (url.pathname === "/probe") {
    try {
      const response = await fetch(url.searchParams.get("url"));
      const body = await response.text();
      res.end(JSON.stringify({ status: response.status, body }));
    } catch (error) {
      res.end(JSON.stringify({ error: String(error.cause ?? error) }));
    }
    return;
  }
  if (url.pathname === "/probe-tls") {
    res.end(JSON.stringify(await getTls(url.searchParams.get("url"))));
    return;
  }
  if (url.pathname === "/ca") {
    res.end(JSON.stringify({ exists: fs.existsSync(CA) }));
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});

server.listen(8080, () => {
  console.log("intercept probe server listening on 8080");
});
