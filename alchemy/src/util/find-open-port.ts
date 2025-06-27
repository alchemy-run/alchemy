import net from "node:net";

export async function findOpenPort(min = 1337, max = 65535): Promise<number> {
  for (let port = min; port <= max; port++) {
    if (await isPortAvailable("0.0.0.0", port)) {
      return port;
    }
  }
  throw new Error(`No open port found between ${min} and ${max}`);
}

async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.on("error", () => {
      // Port is in use
      resolve(false);
    });

    server.listen(port, host, () => {
      // Port is available
      server.close(() => resolve(true));
    });
  });
}
