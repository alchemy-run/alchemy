// Probe server for the Linux host-gateway Prisma regression (#1334).
// `/env` reports the DATABASE_URL the process actually received (including
// duplicate-key count from the raw environ, because glibc getenv is first
// match). `/probe` TCP-connects to that URL from inside the container —
// the failure mode was `dial error: timeout` to 172.17.0.1:port.
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");

const countEnv = (name) => {
  try {
    return fs
      .readFileSync("/proc/self/environ", "utf8")
      .split("\0")
      .filter((entry) => entry.startsWith(`${name}=`)).length;
  } catch {
    return undefined;
  }
};

const tcpProbe = (hostname, port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port }, () => {
      socket.end();
      resolve({ ok: true, host: hostname, port });
    });
    socket.setTimeout(4000, () => {
      socket.destroy();
      resolve({ ok: false, host: hostname, port, error: "timeout" });
    });
    socket.on("error", (error) =>
      resolve({ ok: false, host: hostname, port, error: String(error) }),
    );
  });

const server = http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/env") {
    res.end(
      JSON.stringify({
        DATABASE_URL: process.env.DATABASE_URL,
        databaseUrlCount: countEnv("DATABASE_URL"),
      }),
    );
    return;
  }
  if (req.url === "/probe") {
    const value = process.env.DATABASE_URL;
    if (!value) {
      res.end(JSON.stringify({ error: "missing DATABASE_URL" }));
      return;
    }
    try {
      const url = new URL(value);
      res.end(JSON.stringify(await tcpProbe(url.hostname, Number(url.port))));
    } catch (error) {
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  res.end(JSON.stringify({ ok: true }));
});

server.listen(8080, () => {
  console.log("prismahost probe server listening on 8080");
});
