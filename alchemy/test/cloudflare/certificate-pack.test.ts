import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import {
  type CloudflareApi,
  createCloudflareApi,
} from "../../src/cloudflare/api.ts";
import { CertificatePack } from "../../src/cloudflare/certificate-pack.ts";
import { Zone } from "../../src/cloudflare/zone.ts";
import { destroy } from "../../src/destroy.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const api = await createCloudflareApi();

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe.skipIf(!process.env.ALL_TESTS)("CertificatePack Resource", () => {
  // Use BRANCH_PREFIX for deterministic, non-colliding resource names
  const testDomain = `${BRANCH_PREFIX}-cert-test.dev`;

  test("create, update cloudflare branding, and delete certificate pack", async (scope) => {
    let zone: Zone | undefined;
    let certificatePack: CertificatePack | undefined;

    try {
      // First create a test zone for the certificate pack
      zone = await Zone(testDomain, {
        name: testDomain,
        type: "full",
        jumpStart: false,
      });

      expect(zone.id).toBeTruthy();
      expect(zone.name).toEqual(testDomain);

      // Create a certificate pack with Let's Encrypt
      certificatePack = await CertificatePack(`${BRANCH_PREFIX}-cert`, {
        zone: zone,
        certificateAuthority: "lets_encrypt",
        hosts: [testDomain, `www.${testDomain}`],
        validationMethod: "txt",
        validityDays: 90,
        cloudflareBranding: false,
      });

      expect(certificatePack.id).toBeTruthy();
      expect(certificatePack.certificateAuthority).toEqual("lets_encrypt");
      expect(certificatePack.hosts).toEqual([testDomain, `www.${testDomain}`]);
      expect(certificatePack.validationMethod).toEqual("txt");
      expect(certificatePack.validityDays).toEqual(90);
      expect(certificatePack.type).toEqual("advanced");
      expect(certificatePack.cloudflareBranding).toEqual(false);
      expect(certificatePack.zoneId).toEqual(zone.id);

      // Verify certificate pack was created by querying the API directly
      const getResponse = await api.get(
        `/zones/${zone.id}/ssl/certificate_packs/${certificatePack.id}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData: any = await getResponse.json();
      expect(responseData.result.id).toEqual(certificatePack.id);
      expect(responseData.result.certificate_authority).toEqual("lets_encrypt");
      expect(responseData.result.validation_method).toEqual("txt");
      expect(responseData.result.validity_days).toEqual(90);
      expect(responseData.result.cloudflare_branding).toEqual(false);

      // Update the certificate pack to enable Cloudflare branding
      // This is the only property that can be updated
      certificatePack = await CertificatePack(`${BRANCH_PREFIX}-cert`, {
        zone: zone,
        certificateAuthority: "lets_encrypt",
        hosts: [testDomain, `www.${testDomain}`],
        validationMethod: "txt",
        validityDays: 90,
        cloudflareBranding: true, // Only change this property
      });

      expect(certificatePack.cloudflareBranding).toEqual(true);
      expect(certificatePack.certificateAuthority).toEqual("lets_encrypt");
      expect(certificatePack.hosts).toEqual([testDomain, `www.${testDomain}`]);

      // Verify the update was applied in the API
      const updatedResponse = await api.get(
        `/zones/${zone.id}/ssl/certificate_packs/${certificatePack.id}`,
      );
      const updatedData: any = await updatedResponse.json();
      expect(updatedData.result.cloudflare_branding).toEqual(true);
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify certificate pack was deleted
      if (certificatePack && zone) {
        await assertCertificatePackDoesNotExist(
          api,
          zone.id,
          certificatePack.id,
        );
      }

      // Verify zone was deleted
      if (zone) {
        const getDeletedResponse = await api.get(`/zones/${zone.id}`);
        const text = await getDeletedResponse.text();
        expect(text).toContain("Invalid zone identifier");
        expect(getDeletedResponse.status).toEqual(400);
      }
    }
  });

  test("prevent updating immutable properties", async (scope) => {
    let zone: Zone | undefined;
    let certificatePack: CertificatePack | undefined;

    try {
      // Create a test zone
      zone = await Zone(`${testDomain}-immutable`, {
        name: `${testDomain}-immutable`,
        type: "full",
        jumpStart: false,
      });

      // Create initial certificate pack
      certificatePack = await CertificatePack(
        `${BRANCH_PREFIX}-immutable-cert`,
        {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: [`${testDomain}-immutable`],
          validationMethod: "txt",
          validityDays: 90,
        },
      );

      expect(certificatePack.id).toBeTruthy();

      // Try to update certificate authority (should fail)
      await expect(
        CertificatePack(`${BRANCH_PREFIX}-immutable-cert`, {
          zone: zone,
          certificateAuthority: "google", // Changed from lets_encrypt
          hosts: [`${testDomain}-immutable`],
          validationMethod: "txt",
          validityDays: 90,
        }),
      ).rejects.toThrow(
        "Cannot change certificateAuthority from 'lets_encrypt' to 'google'",
      );

      // Try to update hosts (should fail)
      await expect(
        CertificatePack(`${BRANCH_PREFIX}-immutable-cert`, {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: [`${testDomain}-immutable`, `www.${testDomain}-immutable`], // Added host
          validationMethod: "txt",
          validityDays: 90,
        }),
      ).rejects.toThrow("Cannot change hosts from");

      // Try to update validation method (should fail)
      await expect(
        CertificatePack(`${BRANCH_PREFIX}-immutable-cert`, {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: [`${testDomain}-immutable`],
          validationMethod: "http", // Changed from txt
          validityDays: 90,
        }),
      ).rejects.toThrow("Cannot change validationMethod from 'txt' to 'http'");

      // Try to update validity days (should fail)
      await expect(
        CertificatePack(`${BRANCH_PREFIX}-immutable-cert`, {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: [`${testDomain}-immutable`],
          validationMethod: "txt",
          validityDays: 365, // Changed from 90
        }),
      ).rejects.toThrow("Cannot change validityDays from 90 to 365");

      // Try to update type (should fail)
      await expect(
        CertificatePack(`${BRANCH_PREFIX}-immutable-cert`, {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: [`${testDomain}-immutable`],
          validationMethod: "txt",
          validityDays: 90,
          type: "advanced", // Explicit type change attempt
        }),
      ).rejects.toThrow("Cannot change type from 'advanced' to 'advanced'");
    } finally {
      await destroy(scope);

      if (certificatePack && zone) {
        await assertCertificatePackDoesNotExist(
          api,
          zone.id,
          certificatePack.id,
        );
      }
    }
  });

  test("create certificate pack with zone ID string", async (scope) => {
    let zone: Zone | undefined;
    let certificatePack: CertificatePack | undefined;

    try {
      // Create a test zone
      zone = await Zone(`${testDomain}-string-id`, {
        name: `${testDomain}-string-id`,
        type: "full",
        jumpStart: false,
      });

      // Create certificate pack using zone ID string instead of Zone object
      certificatePack = await CertificatePack(`${BRANCH_PREFIX}-string-cert`, {
        zone: zone.id, // Use zone ID string
        certificateAuthority: "lets_encrypt",
        hosts: [`${testDomain}-string-id`, `*.${testDomain}-string-id`],
        validationMethod: "txt",
        validityDays: 30,
        cloudflareBranding: true,
      });

      expect(certificatePack.id).toBeTruthy();
      expect(certificatePack.zoneId).toEqual(zone.id);
      expect(certificatePack.hosts).toEqual([
        `${testDomain}-string-id`,
        `*.${testDomain}-string-id`,
      ]);
      expect(certificatePack.validityDays).toEqual(30);
      expect(certificatePack.cloudflareBranding).toEqual(true);

      // Verify with API
      const getResponse = await api.get(
        `/zones/${zone.id}/ssl/certificate_packs/${certificatePack.id}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData: any = await getResponse.json();
      expect(responseData.result.hosts).toEqual([
        `${testDomain}-string-id`,
        `*.${testDomain}-string-id`,
      ]);
      expect(responseData.result.validity_days).toEqual(30);
      expect(responseData.result.cloudflare_branding).toEqual(true);
    } finally {
      await destroy(scope);

      if (certificatePack && zone) {
        await assertCertificatePackDoesNotExist(
          api,
          zone.id,
          certificatePack.id,
        );
      }
    }
  });

  test("validate host requirements", async (scope) => {
    let zone: Zone | undefined;

    try {
      // Create a test zone
      zone = await Zone(`${testDomain}-validation`, {
        name: `${testDomain}-validation`,
        type: "full",
        jumpStart: false,
      });

      // Test empty hosts array (should fail)
      await expect(
        CertificatePack(`${BRANCH_PREFIX}-empty-hosts`, {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: [], // Empty array
          validationMethod: "txt",
          validityDays: 90,
        }),
      ).rejects.toThrow("At least one host must be specified");

      // Test too many hosts (should fail)
      const tooManyHosts = Array.from(
        { length: 51 },
        (_, i) => `host${i}.${testDomain}-validation`,
      );
      await expect(
        CertificatePack(`${BRANCH_PREFIX}-too-many-hosts`, {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: tooManyHosts, // 51 hosts > 50 limit
          validationMethod: "txt",
          validityDays: 90,
        }),
      ).rejects.toThrow("Maximum 50 hosts are allowed per certificate pack");
    } finally {
      await destroy(scope);
    }
  });

  test("auto-infer zone from hostname", async (scope) => {
    let zone: Zone | undefined;
    let certificatePack: CertificatePack | undefined;

    try {
      // Create a test zone
      zone = await Zone(`${testDomain}-auto-infer`, {
        name: `${testDomain}-auto-infer`,
        type: "full",
        jumpStart: false,
      });

      // Create certificate pack without specifying zone - should auto-infer
      certificatePack = await CertificatePack(
        `${BRANCH_PREFIX}-auto-infer-cert`,
        {
          // zone: omitted - should auto-infer from hosts
          certificateAuthority: "lets_encrypt",
          hosts: [`${testDomain}-auto-infer`, `www.${testDomain}-auto-infer`],
          validationMethod: "txt",
          validityDays: 90,
        },
      );

      expect(certificatePack.id).toBeTruthy();
      expect(certificatePack.zoneId).toEqual(zone.id);
      expect(certificatePack.zoneName).toEqual(`${testDomain}-auto-infer`);
      expect(certificatePack.hosts).toEqual([
        `${testDomain}-auto-infer`,
        `www.${testDomain}-auto-infer`,
      ]);

      // Verify certificate pack was created in the correct zone
      const getResponse = await api.get(
        `/zones/${zone.id}/ssl/certificate_packs/${certificatePack.id}`,
      );
      expect(getResponse.status).toEqual(200);

      const responseData: any = await getResponse.json();
      expect(responseData.result.zone_id).toEqual(zone.id);
    } finally {
      await destroy(scope);

      if (certificatePack && zone) {
        await assertCertificatePackDoesNotExist(
          api,
          zone.id,
          certificatePack.id,
        );
      }
    }
  });

  test("adopt existing certificate pack instead of creating duplicate", async (scope) => {
    let zone: Zone | undefined;
    let firstCertificatePack: CertificatePack | undefined;
    let secondCertificatePack: CertificatePack | undefined;

    try {
      // Create a test zone
      zone = await Zone(`${testDomain}-adopt`, {
        name: `${testDomain}-adopt`,
        type: "full",
        jumpStart: false,
      });

      // Create first certificate pack
      firstCertificatePack = await CertificatePack(
        `${BRANCH_PREFIX}-adopt-cert-1`,
        {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: [`${testDomain}-adopt`, `www.${testDomain}-adopt`],
          validationMethod: "txt",
          validityDays: 90,
        },
      );

      expect(firstCertificatePack.id).toBeTruthy();

      // Create second certificate pack with same configuration - should adopt existing one
      secondCertificatePack = await CertificatePack(
        `${BRANCH_PREFIX}-adopt-cert-2`,
        {
          zone: zone,
          certificateAuthority: "lets_encrypt",
          hosts: [`${testDomain}-adopt`, `www.${testDomain}-adopt`],
          validationMethod: "txt",
          validityDays: 90,
        },
      );

      // Should have the same ID (adopted the existing one)
      expect(secondCertificatePack.id).toEqual(firstCertificatePack.id);
      expect(secondCertificatePack.hosts).toEqual(firstCertificatePack.hosts);
      expect(secondCertificatePack.certificateAuthority).toEqual(
        firstCertificatePack.certificateAuthority,
      );
      expect(secondCertificatePack.validationMethod).toEqual(
        firstCertificatePack.validationMethod,
      );
      expect(secondCertificatePack.validityDays).toEqual(
        firstCertificatePack.validityDays,
      );
    } finally {
      await destroy(scope);

      // Both certificate pack references point to the same underlying cert,
      // so we only need to check once
      if (firstCertificatePack && zone) {
        await assertCertificatePackDoesNotExist(
          api,
          zone.id,
          firstCertificatePack.id,
        );
      }
    }
  });

  test("auto-infer zone with wildcard hostname", async (scope) => {
    let zone: Zone | undefined;
    let certificatePack: CertificatePack | undefined;

    try {
      // Create a test zone
      zone = await Zone(`${testDomain}-wildcard`, {
        name: `${testDomain}-wildcard`,
        type: "full",
        jumpStart: false,
      });

      // Create certificate pack with wildcard hostname - should auto-infer zone
      certificatePack = await CertificatePack(
        `${BRANCH_PREFIX}-wildcard-cert`,
        {
          // zone: omitted - should auto-infer from wildcard host
          certificateAuthority: "lets_encrypt",
          hosts: [`*.${testDomain}-wildcard`, `${testDomain}-wildcard`],
          validationMethod: "txt",
          validityDays: 90,
        },
      );

      expect(certificatePack.id).toBeTruthy();
      expect(certificatePack.zoneId).toEqual(zone.id);
      expect(certificatePack.zoneName).toEqual(`${testDomain}-wildcard`);
      expect(certificatePack.hosts).toEqual([
        `*.${testDomain}-wildcard`,
        `${testDomain}-wildcard`,
      ]);
    } finally {
      await destroy(scope);

      if (certificatePack && zone) {
        await assertCertificatePackDoesNotExist(
          api,
          zone.id,
          certificatePack.id,
        );
      }
    }
  });
});

/**
 * Helper function to verify certificate pack was deleted
 */
async function assertCertificatePackDoesNotExist(
  api: CloudflareApi,
  zoneId: string,
  certificatePackId: string,
): Promise<void> {
  const response = await api.get(
    `/zones/${zoneId}/ssl/certificate_packs/${certificatePackId}`,
  );

  // Certificate pack should either not exist (404) or be marked as deleted
  if (response.status === 404) {
    // Certificate pack not found - expected after deletion
    return;
  }

  if (response.status === 200) {
    const data: any = await response.json();
    if (data.result?.status === "deleted") {
      // Certificate pack exists but is marked as deleted - acceptable
      return;
    }
  }

  // If we get here, the certificate pack still exists and is not deleted
  throw new Error(
    `Certificate pack ${certificatePackId} still exists after deletion attempt`,
  );
}
