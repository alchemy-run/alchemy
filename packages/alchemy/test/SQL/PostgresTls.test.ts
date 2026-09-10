import { withServername } from "@/SQL/PostgresTls.ts";
import { describe, expect, it } from "alchemy-test";
import * as Redacted from "effect/Redacted";

const url = (s: string) => Redacted.make(s);

describe("SQL/PostgresTls withServername", () => {
  it("adds servername when the URL requests TLS via sslmode", () => {
    expect(
      withServername(
        url(
          "postgresql://admin:tok@abc.dsql.us-west-2.on.aws:5432/postgres?sslmode=require",
        ),
        undefined,
      ),
    ).toEqual({ servername: "abc.dsql.us-west-2.on.aws" });
    for (const mode of ["verify-ca", "verify-full"]) {
      expect(
        withServername(
          url(`postgres://u@db.example.com/x?sslmode=${mode}`),
          undefined,
        ),
      ).toEqual({ servername: "db.example.com" });
    }
  });

  it("adds servername when the caller asks for TLS explicitly", () => {
    expect(withServername(url("postgres://u@db.example.com/x"), true)).toEqual({
      servername: "db.example.com",
    });
    expect(
      withServername(url("postgres://u@db.example.com/x"), {
        rejectUnauthorized: false,
      }),
    ).toEqual({ rejectUnauthorized: false, servername: "db.example.com" });
  });

  it("keeps a caller-provided servername", () => {
    expect(
      withServername(url("postgres://u@db.example.com/x?sslmode=require"), {
        servername: "override.example.com",
      }),
    ).toEqual({ servername: "override.example.com" });
  });

  it("leaves plaintext URLs alone so sslmode keeps driving @effect/sql-pg", () => {
    expect(
      withServername(url("postgres://u@db.example.com/x"), undefined),
    ).toBeUndefined();
    expect(
      withServername(
        url("postgres://u@db.example.com/x?sslmode=disable"),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      withServername(
        url("postgres://u@db.example.com/x?sslmode=prefer"),
        undefined,
      ),
    ).toBeUndefined();
    expect(
      withServername(
        url("postgres://u@db.example.com/x?sslmode=require"),
        false,
      ),
    ).toBe(false);
  });

  it("never sets an IP literal as servername", () => {
    expect(
      withServername(url("postgres://u@10.0.0.5/x?sslmode=require"), undefined),
    ).toBeUndefined();
    expect(
      withServername(url("postgres://u@[::1]:5432/x?sslmode=require"), true),
    ).toBe(true);
  });

  it("passes malformed URLs through untouched", () => {
    expect(withServername(url("not a url"), undefined)).toBeUndefined();
    expect(withServername(url("not a url"), true)).toBe(true);
  });
});
