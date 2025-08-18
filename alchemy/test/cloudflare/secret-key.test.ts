import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { SecretKey } from "../../src/cloudflare/secret-key.ts";
import { Worker } from "../../src/cloudflare/worker.ts";
import { destroy } from "../../src/destroy.ts";
import { secret } from "../../src/secret.ts";
import "../../src/test/vitest.ts";
import { fetchAndExpectOK } from "../../src/util/safe-fetch.ts";
import { BRANCH_PREFIX } from "../util.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("SecretKey Binding", () => {
  test("create worker with programmatically generated JWK SecretKey", async (scope) => {
    const workerName = `${BRANCH_PREFIX}-secret-key-jwk-worker`;

    let worker: Worker | undefined;

    try {
      // Generate an RSA key pair programmatically using Web Crypto API
      const keyPair = await crypto.subtle.generateKey(
        {
          name: "RSA-PSS",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true, // extractable
        ["sign", "verify"],
      );

      // Export the private key as JWK
      const privateKeyJwk = await crypto.subtle.exportKey(
        "jwk",
        keyPair.privateKey,
      );

      const secretKey = new SecretKey({
        algorithm: { name: "RSA-PSS", hash: "SHA-256" },
        format: "jwk",
        usages: ["sign"],
        key_jwk: secret(privateKeyJwk),
      });

      // Create a worker that accesses the JWK SecretKey properties and can sign data
      worker = await Worker(workerName, {
        name: workerName,
        adopt: true,
        format: "esm",
        url: true,
        bindings: {
          RSA_KEY: secretKey,
        },
        script: `
          export default {
            async fetch(request, env, ctx) {
              const url = new URL(request.url);

              if (url.pathname === '/jwk-key-info') {
                try {
                  return Response.json({
                    success: true,
                    keyType: typeof env.RSA_KEY,
                    algorithm: env.RSA_KEY.algorithm,
                    usages: env.RSA_KEY.usages,
                    extractable: env.RSA_KEY.extractable,
                    keyFormat: env.RSA_KEY.type // should be "private" for signing keys
                  });
                } catch (error) {
                  return Response.json({
                    success: false,
                    error: error.message
                  }, { status: 500 });
                }
              }

              if (url.pathname === '/sign-with-rsa') {
                try {
                  const dataToSign = url.searchParams.get('data') || 'test-rsa-data';
                  const encoder = new TextEncoder();
                  const data = encoder.encode(dataToSign);

                  // Use the RSA SecretKey binding to sign the data
                  const signature = await crypto.subtle.sign(
                    { name: "RSA-PSS", saltLength: 32 },
                    env.RSA_KEY,
                    data
                  );

                  // Convert signature to hex string for response
                  const signatureArray = new Uint8Array(signature);
                  const signatureHex = Array.from(signatureArray)
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');

                  return Response.json({
                    success: true,
                    data: dataToSign,
                    signature: signatureHex,
                    algorithm: env.RSA_KEY.algorithm.name
                  });
                } catch (error) {
                  return Response.json({
                    success: false,
                    error: error.message
                  }, { status: 500 });
                }
              }

              return new Response('JWK SecretKey Worker is running!', {
                status: 200,
                headers: { 'Content-Type': 'text/plain' }
              });
            }
          };
        `,
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      expect(worker.id).toBeTruthy();
      expect(worker.name).toEqual(workerName);
      expect(worker.bindings).toBeDefined();
      expect(worker.bindings!.RSA_KEY).toBeDefined();
      expect(worker.url).toBeTruthy();

      // Test that the JWK SecretKey binding provides proper CryptoKey information
      const keyInfoResponse = await fetchAndExpectOK(
        `${worker.url}/jwk-key-info`,
      );
      const keyInfo: any = await keyInfoResponse.json();

      expect(keyInfo.success).toEqual(true);
      expect(keyInfo.keyType).toEqual("object"); // CryptoKey is an object
      expect(keyInfo.algorithm.name).toEqual("RSA-PSS");
      expect(keyInfo.algorithm.hash.name).toEqual("SHA-256");
      expect(keyInfo.usages).toContain("sign");
      expect(keyInfo.extractable).toEqual(false); // SecretKeys are typically non-extractable
      expect(keyInfo.keyFormat).toEqual("private"); // RSA signing keys are private keys

      // Test signing data with the programmatically generated RSA key
      const testData = "rsa-test-data";
      const signResponse = await fetchAndExpectOK(
        `${worker.url}/sign-with-rsa?data=${encodeURIComponent(testData)}`,
      );
      const signResult: any = await signResponse.json();

      expect(signResult.success).toEqual(true);
      expect(signResult.data).toEqual(testData);
      expect(signResult.signature).toBeTruthy();
      expect(typeof signResult.signature).toEqual("string");
      expect(signResult.algorithm).toEqual("RSA-PSS");

      // Verify the signature is valid by using the public key we generated
      const signatureArray = new Uint8Array(
        signResult.signature
          .match(/.{1,2}/g)
          .map((byte: string) => Number.parseInt(byte, 16)),
      );
      const encoder = new TextEncoder();
      const data = encoder.encode(testData);

      const isValid = await crypto.subtle.verify(
        { name: "RSA-PSS", saltLength: 32 },
        keyPair.publicKey,
        signatureArray,
        data,
      );

      expect(isValid).toEqual(true);
    } finally {
      await destroy(scope);
    }
  });
});
