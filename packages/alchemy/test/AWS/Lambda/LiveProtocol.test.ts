import {
  CHUNK_SIZE,
  PacketAssembler,
  channelPrefix,
  encodePackets,
  workerChannel,
} from "@/AWS/Lambda/Live/Protocol.ts";
import { signRequest } from "@/AWS/Lambda/Live/SigV4.ts";
import { describe, expect, it } from "alchemy-test";

describe("Live Lambda protocol", () => {
  it("round-trips an empty body", () => {
    const packets = encodePackets("next", "worker-1", "request-1", undefined);
    expect(packets).toHaveLength(1);

    const message = new PacketAssembler().push(packets[0]);
    expect(message).toEqual({
      type: "next",
      source: "worker-1",
      id: "request-1",
      body: "{}",
    });
  });

  it("reassembles interleaved, out-of-order messages", () => {
    const large = "x".repeat(CHUNK_SIZE * 2 + 1);
    const first = encodePackets("next", "worker-1", "request-1", { large });
    const second = encodePackets("response", "dev", "request-2", {
      result: "done",
    });
    const assembler = new PacketAssembler();

    expect(assembler.push(first[2])).toBeUndefined();
    expect(assembler.push(second[0])).toEqual({
      type: "response",
      source: "dev",
      id: "request-2",
      body: JSON.stringify({ result: "done" }),
    });
    expect(assembler.push(first[0])).toBeUndefined();
    expect(assembler.push(first[1])).toEqual({
      type: "next",
      source: "worker-1",
      id: "request-1",
      body: JSON.stringify({ large }),
    });
  });

  it("sanitizes stack and stage channel segments", () => {
    const prefix = channelPrefix("alchemy", "my stack", "dev/saatvik");
    expect(prefix).toBe("/alchemy/my-stack/dev-saatvik");
    expect(workerChannel(prefix, "sandbox-1")).toBe(
      "/alchemy/my-stack/dev-saatvik/sandbox-1/in",
    );
  });
});

describe("Live Lambda SigV4", () => {
  it("matches the AWS IAM ListUsers reference signature", () => {
    const headers = signRequest(
      {
        method: "GET",
        url: new URL(
          "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
        ),
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: "",
      },
      {
        credentials: {
          accessKeyId: "AKIDEXAMPLE",
          secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        },
        region: "us-east-1",
        service: "iam",
        date: new Date("2015-08-30T12:36:00.000Z"),
      },
    );

    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});
