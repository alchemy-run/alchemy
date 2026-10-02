import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Self-signed P-256 CA certificates (CN=alchemy-test-ca-a / -b, valid until
// 2036), generated once with openssl. The private keys were discarded.
const pem = (body: string) =>
  `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
const CA_A_BODY =
  "MIIBnDCCAUOgAwIBAgIUGv6NR3JzNfnl/bDq39kCtQj+OjUwCgYIKoZIzj0EAwIwHDEaMBgGA1UEAwwRYWxjaGVteS10ZXN0LWNhLWEwHhcNMjYxMDAyMDQzMzI5WhcNMzYwOTI5MDQzMzI5WjAcMRowGAYDVQQDDBFhbGNoZW15LXRlc3QtY2EtYTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABA5OyTF89+NMrsZOiTZJwLmJCwuRbykfVlK5j6xv2ZA7VzcypGMmT+rc6VC6gVJwsql5BoTCrZ+vwqTD/w1/sxSjYzBhMB0GA1UdDgQWBBRGXf+fBLAbYifOVUcRUX5N+m62pzAfBgNVHSMEGDAWgBRGXf+fBLAbYifOVUcRUX5N+m62pzAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNHADBEAiAimEOuxsoS7doQIt2LdZAXPlYY6ir25iILj1xEFmgATAIgP2K52wGTg0+ZdKQ+8eSuS3VNHEhpq8aceVUevDERRac=";
const CA_B_BODY =
  "MIIBnTCCAUOgAwIBAgIUeQWIn+6+wca8K2smxp1f/AYYfhgwCgYIKoZIzj0EAwIwHDEaMBgGA1UEAwwRYWxjaGVteS10ZXN0LWNhLWIwHhcNMjYxMDAyMDQzMzI5WhcNMzYwOTI5MDQzMzI5WjAcMRowGAYDVQQDDBFhbGNoZW15LXRlc3QtY2EtYjBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAYVn5/P3LlMbcfMPYtNz03+95IwZHnQi/8PLL0dhKVHfw8a+iGADYW9N2ONCp8c2lTzRvLF8d5n1t2NPodXVwKjYzBhMB0GA1UdDgQWBBSb93sz1+UjljSi1zfLhMY1WWyItjAfBgNVHSMEGDAWgBSb93sz1+UjljSi1zfLhMY1WWyItjAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBBjAKBggqhkjOPQQDAgNIADBFAiA8A+9lvrobyeMuCfAN4CWcMhV/7z8FpGclimohYiGi5AIhAKPnGB3zACezDFYYvrybmU/AORGqIz2uBWsBN0RCjmtZ";

const CA_A = pem(CA_A_BODY);
const CA_B = pem(CA_B_BODY);

const getCertificate = (
  resourceGroupName: string,
  namespaceName: string,
  caCertificateName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* eventgrid.GetCaCertificate({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      caCertificateName,
    });
  });

const certificateGone = (
  resourceGroupName: string,
  namespaceName: string,
  caCertificateName: string,
) =>
  getCertificate(resourceGroupName, namespaceName, caCertificateName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 12,
    }),
  );

const program = (props: { certificate: string; description?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const namespace = yield* Azure.EventGrid.Namespace("Broker", {
      resourceGroup: group.resourceGroupName,
      topicSpacesConfiguration: { state: "Enabled" },
    });
    const ca = yield* Azure.EventGrid.CaCertificate("DevicesCa", {
      resourceGroup: group.resourceGroupName,
      namespace: namespace.namespaceName,
      encodedCertificate: props.certificate,
      description: props.description,
    });
    return { group, namespace, ca };
  });

// One throughput unit with the MQTT broker for ~10 minutes; well under $0.10.
test.provider(
  "create, replace, and delete an event grid MQTT CA certificate",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace, ca } = yield* stack.deploy(
        program({ certificate: CA_A }),
      );
      expect(ca.expiryTimeInUtc).toBeDefined();
      expect(Date.parse(ca.expiryTimeInUtc!)).toBeGreaterThan(
        Date.parse("2036-01-01T00:00:00Z"),
      );
      const observed = yield* getCertificate(
        group.resourceGroupName,
        namespace.namespaceName,
        ca.caCertificateName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.description).toMatch(/^\[alchemy:/);

      // Azure rejects updates of CA certificates: a new description replaces.
      const described = yield* stack.deploy(
        program({ certificate: CA_A, description: "device fleet CA" }),
      );
      expect(described.ca.caCertificateName).not.toEqual(ca.caCertificateName);
      expect(described.ca.description).toEqual("device fleet CA");
      const reobserved = yield* getCertificate(
        group.resourceGroupName,
        namespace.namespaceName,
        described.ca.caCertificateName,
      );
      expect(reobserved.properties?.description).toMatch(
        /^device fleet CA \[alchemy:/,
      );
      expect(
        yield* certificateGone(
          group.resourceGroupName,
          namespace.namespaceName,
          ca.caCertificateName,
        ),
      ).toEqual("gone");

      // A new certificate replaces the resource.
      const replaced = yield* stack.deploy(
        program({ certificate: CA_B, description: "device fleet CA" }),
      );
      expect(replaced.ca.caCertificateName).not.toEqual(
        described.ca.caCertificateName,
      );
      const replacement = yield* getCertificate(
        group.resourceGroupName,
        namespace.namespaceName,
        replaced.ca.caCertificateName,
      );
      expect(
        replacement.properties?.encodedCertificate?.replace(/\s/g, ""),
      ).toContain(CA_B_BODY.slice(0, 40));
      expect(
        yield* certificateGone(
          group.resourceGroupName,
          namespace.namespaceName,
          described.ca.caCertificateName,
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* certificateGone(
          group.resourceGroupName,
          namespace.namespaceName,
          replaced.ca.caCertificateName,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:eventgrid", "live"],
    timeout: 600_000,
  },
);
