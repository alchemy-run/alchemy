import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

/** Docker exec needs stdin EOF without closing its stdout/stderr connection. */
export const connectDockerSocket = (path: string): NodeStream.Duplex => {
  if (typeof Bun === "undefined")
    return NodeNet.createConnection({ path, allowHalfOpen: true });

  // Bun 1.3's node:net Socket.end() closes both halves. Its public socket
  // API exposes the write-only shutdown Docker's hijacked streams require.
  let socket: Bun.Socket | undefined;
  let pending: Buffer | undefined;
  let written: ((error?: Error | null) => void) | undefined;
  const flush = () => {
    if (!socket || !pending) return;
    const count = socket.write(pending);
    pending = pending.subarray(count);
    if (pending.length === 0) {
      pending = undefined;
      const callback = written;
      written = undefined;
      callback?.();
    }
  };
  const stream = new NodeStream.Duplex({
    allowHalfOpen: true,
    construct(callback) {
      Bun.connect({
        unix: path,
        allowHalfOpen: true,
        socket: {
          data(socket, data) {
            if (!stream.push(data)) socket.pause();
          },
          drain: flush,
          end() {
            stream.push(null);
          },
          close() {
            if (written)
              stream.destroy(new Error("Docker socket closed during a write."));
            else stream.push(null);
          },
          error(_socket, error) {
            stream.destroy(error);
          },
        },
      }).then((connected) => {
        socket = connected;
        callback();
      }, callback);
    },
    read() {
      socket?.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      pending = chunk;
      written = callback;
      flush();
    },
    final(callback) {
      // Bun's implementation uses shutdown() for SHUT_WR; passing true
      // shuts down reads, despite the 1.3 type declaration's description.
      socket?.shutdown();
      callback();
    },
    destroy(error, callback) {
      socket?.terminate();
      callback(error);
    },
  });
  return stream;
};
