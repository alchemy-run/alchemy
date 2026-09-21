import { makeEc2UserData, type Ec2NodeSizing } from "@/Celld/EcsEc2.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

const sizing: Ec2NodeSizing = {
  architecture: "X86_64",
  hostMemoryMiB: 8192,
  hostCpuUnits: 2048,
  reservedMemoryMiB: 2048,
  kernelReserveMiB: 256,
  memoryMiB: 4096,
  cpuUnits: 1024,
  nodes: 1,
};

const executeRegistration = (associated: boolean) =>
  Effect.gen(function* () {
    const userData = makeEc2UserData(
      "celld-test",
      "us-east-1",
      sizing,
      "runsc",
    );
    const script = userData
      .split("<<'REGISTER'\n")[1]!
      .split("\nREGISTER\n")[0]!;
    const stubs = `
curl() {
  case "$*" in
    *latest/api/token*) printf 'token';;
    *security-credentials/role*) printf '{"AccessKeyId":"key","SecretAccessKey":"secret","Token":"session"}';;
    *security-credentials/*) printf 'role';;
    *DescribeClusters*) printf '%s' '${JSON.stringify({ clusters: [{ capacityProviders: associated ? ["celld-test-capacity"] : ["other-capacity"] }] })}';;
    *) return 1;;
  esac
}
sleep() { :; }
touch() { printf 'READY\\n'; }
systemctl() { printf 'SYSTEMCTL %s\\n' "$*"; }
`;
    const process = yield* ChildProcess.make(
      "bash",
      ["-c", `${stubs}\n${script}`],
      { stdout: "pipe", stderr: "ignore" },
    );
    const output = yield* process.stdout.pipe(
      Stream.decodeText,
      Stream.mkString,
    );
    return { output, exitCode: yield* process.exitCode };
  });

test.effect(
  "EC2 registration can recover on a later service invocation after association was unavailable",
  () =>
    Effect.gen(function* () {
      const unavailable = yield* executeRegistration(false);
      expect(unavailable.exitCode).toBe(1);
      expect(unavailable.output).not.toContain("READY");
      expect(unavailable.output).not.toContain("SYSTEMCTL");
      const recovered = yield* executeRegistration(true);
      expect(recovered.exitCode).toBe(0);
      expect(recovered.output).toContain("READY");
      expect(recovered.output).toContain(
        "SYSTEMCTL enable --now --no-block ecs",
      );
      expect(recovered.output).toContain(
        "SYSTEMCTL start --no-block celld-host-cleanup",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
