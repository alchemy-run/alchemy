interface Env {
  EFFECT_ECHO: Fetcher;
  ASYNC_ECHO: Fetcher;
}

/**
 * Plain async caller: `GET /effect?message=ping` or `GET /async?message=ping`
 * opens a TCP connection to the matching echo Worker with the service
 * binding's native `connect()`, sends the message, and returns everything
 * written back until the echoed line arrives.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const message = url.searchParams.get("message") ?? "ping";
    const target = url.pathname === "/async" ? env.ASYNC_ECHO : env.EFFECT_ECHO;
    const socket = target.connect("echo.internal:7");
    try {
      const writer = socket.writable.getWriter();
      await writer.write(new TextEncoder().encode(`${message}\n`));
      const reader = (socket.readable as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      const expected = `${message.toUpperCase()}\n`;
      let received = "";
      while (!received.includes(expected)) {
        const { done, value } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
      return new Response(received);
    } catch (error) {
      return new Response(`client failed: ${error}`, { status: 500 });
    } finally {
      await socket.close().catch(() => {});
    }
  },
};
