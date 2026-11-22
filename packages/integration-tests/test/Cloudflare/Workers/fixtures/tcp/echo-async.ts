/**
 * Plain async TCP echo Worker: the same protocol as `echo.ts` (greeting with
 * the address the caller connected to, then each chunk upper-cased).
 */
export default {
  async connect(socket: Socket): Promise<void> {
    const info = await socket.opened;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const writer = socket.writable.getWriter();
    await writer.write(encoder.encode(`hello ${info.localAddress ?? "?"}\n`));
    for await (const chunk of socket.readable as ReadableStream<Uint8Array>) {
      await writer.write(encoder.encode(decoder.decode(chunk).toUpperCase()));
    }
    await writer.close();
  },
};
