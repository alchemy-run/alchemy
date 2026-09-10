import { resolveSsl } from "@/SQL/PostgresTls.ts";
import { describe, expect, it } from "alchemy-test";
import * as Redacted from "effect/Redacted";

const url = (s: string) => Redacted.make(s);

describe("SQL/PostgresTls resolveSsl", () => {
  it("adds servername when the URL requests TLS via sslmode", () => {
    expect(
      resolveSsl(
        url(
          "postgresql://admin:tok@abc.dsql.us-west-2.on.aws:5432/postgres?sslmode=require",
        ),
        undefined,
      ),
    ).toEqual({ servername: "abc.dsql.us-west-2.on.aws" });
    for (const mode of ["verify-ca", "verify-full"]) {
      expect(
        resolveSsl(
          url(`postgres://u@db.example.com/x?sslmode=${mode}`),
          undefined,
        ),
      ).toEqual({ servername: "db.example.com" });
    }
  });

  it("adds servername when the caller asks for TLS explicitly", () => {
    expect(resolveSsl(url("postgres://u@db.example.com/x"), true)).toEqual({
      servername: "db.example.com",
    });
    expect(
      resolveSsl(url("postgres://u@db.example.com/x"), {
        rejectUnauthorized: false,
      }),
    ).toEqual({ rejectUnauthorized: false, servername: "db.example.com" });
  });

  it("keeps a caller-provided servername", () => {
    expect(
      resolveSsl(url("postgres://u@db.example.com/x?sslmode=require"), {
        servername: "override.example.com",
      }),
    ).toEqual({ servername: "override.example.com" });
  });

  it("leaves plaintext URLs alone so sslmode keeps driving @effect/sql-pg", () => {
    expect(
      resolveSsl(url("postgres://u@db.example.com/x"), undefined),
    ).toBeUndefined();
    expect(
      resolveSsl(
        url("postgres://u@db.example.com/x?sslmode=disable"),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      resolveSsl(url("postgres://u@db.example.com/x?sslmode=require"), false),
    ).toBe(false);
  });

  it("resolves sslmode=prefer|allow to TLS on (rc.113 rejects them when ssl is implicit)", () => {
    for (const mode of ["prefer", "allow"]) {
      expect(
        resolveSsl(
          url(`postgres://u@ep-x.neon.tech/x?sslmode=${mode}`),
          undefined,
        ),
      ).toEqual({ servername: "ep-x.neon.tech" });
      expect(
        resolveSsl(
          url(`postgres://u@127.0.0.1:5432/x?sslmode=${mode}`),
          undefined,
        ),
      ).toBe(true);
    }
  });

  it("never sets an IP literal as servername", () => {
    expect(
      resolveSsl(url("postgres://u@10.0.0.5/x?sslmode=require"), undefined),
    ).toBe(true);
    expect(
      resolveSsl(url("postgres://u@[::1]:5432/x?sslmode=require"), true),
    ).toBe(true);
    expect(
      resolveSsl(url("postgres://u@[::1]:5432/x?sslmode=require"), {
        rejectUnauthorized: false,
      }),
    ).toEqual({ rejectUnauthorized: false });
  });

  it("passes malformed URLs through untouched", () => {
    expect(resolveSsl(url("not a url"), undefined)).toBeUndefined();
    expect(resolveSsl(url("not a url"), true)).toBe(true);
  });
});
