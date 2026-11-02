import * as net from "node:net";
import {
  formatSyslogLine,
  parseSyslogDrain,
  sendSyslog,
} from "@alchemy.run/stackit/internal/syslog";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

describe("parseSyslogDrain", () => {
  it("reads each transport the client speaks", () => {
    expect(parseSyslogDrain("syslog://logs.example:1514")).toEqual({
      hostname: "logs.example",
      port: 1514,
      tls: false,
    });
    expect(parseSyslogDrain("tcp://logs.example:1514")?.tls).toBe(false);
    expect(parseSyslogDrain("syslog-tls://user:pw@logs.example:6514")).toEqual({
      hostname: "logs.example",
      port: 6514,
      tls: true,
    });
    expect(parseSyslogDrain("tls://logs.example:6514")?.tls).toBe(true);
  });

  it("refuses what it can't send to", () => {
    expect(parseSyslogDrain("udp://logs.example:514")).toBeUndefined();
    expect(parseSyslogDrain("https://logs.example:443")).toBeUndefined();
    expect(parseSyslogDrain("syslog://logs.example")).toBeUndefined();
    expect(parseSyslogDrain("logs.example:1514")).toBeUndefined();
  });
});

describe("formatSyslogLine", () => {
  const AT = "2026-11-01T10:00:00.000Z";

  it("writes an RFC 5424 line with defaults", () => {
    expect(formatSyslogLine("hello", AT)).toEqual(`<14>1 ${AT} - - - - - hello\n`);
  });

  it("takes the priority and names from the entry", () => {
    expect(
      formatSyslogLine(
        { message: "boom", severity: 3, facility: 16, appName: "my app", hostname: "web-1" },
        AT,
      ),
    ).toEqual(`<131>1 ${AT} web-1 my_app - - - boom\n`);
  });

  it("keeps a message on one line", () => {
    expect(formatSyslogLine("a\nb\r\nc", AT)).toEqual(`<14>1 ${AT} - - - - - a b c\n`);
  });
});

describe("sendSyslog", () => {
  /** A local TCP listener: no STACKIT and no credentials are involved. */
  const listen = Effect.callback<{
    readonly port: number;
    readonly received: Promise<string>;
    readonly close: () => void;
  }>((resume) => {
    let resolve: (text: string) => void = () => {};
    const received = new Promise<string>((done) => {
      resolve = done;
    });
    const server = net.createServer((socket) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("end", () => resolve(text));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resume(Effect.succeed({ port: address.port, received, close: () => void server.close() }));
    });
  });

  it.live("writes each entry and closes the socket", () =>
    Effect.gen(function* () {
      const { port, received, close } = yield* listen;
      yield* sendSyslog(Redacted.make(`syslog://127.0.0.1:${port}`), [
        "first",
        { message: "second", appName: "api" },
      ]);
      const text = yield* Effect.promise(() => received);
      close();
      const lines = text.trimEnd().split("\n");
      expect(lines.length).toEqual(2);
      expect(lines[0]).toMatch(/^<14>1 \S+ - - - - - first$/);
      expect(lines[1]).toMatch(/^<14>1 \S+ - api - - - second$/);
    }),
  );

  it.live("fails with the typed error on a scheme it can't send to, without the URL", () =>
    Effect.gen(function* () {
      const error = yield* sendSyslog("udp://user:secret@logs.example:514", "x").pipe(Effect.flip);
      expect(error._tag).toEqual("Stackit.LogMe.SyslogDrainUnsupported");
      expect(error.message).not.toContain("secret");
    }),
  );

  it.live("fails with the typed error when nothing listens", () =>
    Effect.gen(function* () {
      const error = yield* sendSyslog("syslog://127.0.0.1:1", "x").pipe(Effect.flip);
      expect(error._tag).toEqual("Stackit.LogMe.SyslogWriteFailed");
    }),
  );
});
