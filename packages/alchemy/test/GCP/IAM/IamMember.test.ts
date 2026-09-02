import { applyIamMemberChange } from "@/GCP/IAM/IamMember.ts";
import { describe, expect, it } from "alchemy-test";

describe("GCP IAM member policy updates", () => {
  const conditional = {
    role: "roles/viewer",
    members: ["user:conditional@example.com"],
    condition: {
      expression: "request.time < timestamp('2030-01-01T00:00:00Z')",
    },
  };

  it("adds a member without replacing unrelated or conditional bindings", () => {
    const updated = applyIamMemberChange(
      {
        etag: "etag-1",
        version: 3,
        bindings: [
          { role: "roles/editor", members: ["user:owner@example.com"] },
          conditional,
        ],
      },
      "roles/viewer",
      "serviceAccount:worker@example.iam.gserviceaccount.com",
      "add",
    );

    expect(updated).toEqual({
      etag: "etag-1",
      version: 3,
      bindings: [
        { role: "roles/editor", members: ["user:owner@example.com"] },
        conditional,
        {
          role: "roles/viewer",
          members: ["serviceAccount:worker@example.iam.gserviceaccount.com"],
        },
      ],
    });
  });

  it("removes only the managed member and drops an empty binding", () => {
    const updated = applyIamMemberChange(
      {
        etag: "etag-2",
        bindings: [
          {
            role: "roles/viewer",
            members: ["serviceAccount:worker@example.iam.gserviceaccount.com"],
          },
          { role: "roles/editor", members: ["user:owner@example.com"] },
        ],
      },
      "roles/viewer",
      "serviceAccount:worker@example.iam.gserviceaccount.com",
      "remove",
    );

    expect(updated).toEqual({
      etag: "etag-2",
      bindings: [{ role: "roles/editor", members: ["user:owner@example.com"] }],
    });
  });

  it("leaves a conditional binding on the same role untouched when removing", () => {
    const conditionalViewer = {
      role: "roles/viewer",
      members: ["serviceAccount:worker@example.iam.gserviceaccount.com"],
      condition: { expression: "resource.name == 'x'" },
    };
    const updated = applyIamMemberChange(
      {
        etag: "etag-3",
        bindings: [
          conditionalViewer,
          {
            role: "roles/viewer",
            members: [
              "serviceAccount:worker@example.iam.gserviceaccount.com",
              "user:owner@example.com",
            ],
          },
        ],
      },
      "roles/viewer",
      "serviceAccount:worker@example.iam.gserviceaccount.com",
      "remove",
    );

    expect(updated).toEqual({
      etag: "etag-3",
      bindings: [
        conditionalViewer,
        { role: "roles/viewer", members: ["user:owner@example.com"] },
      ],
    });
  });

  it("does not write when the requested state already exists", () => {
    const policy = {
      bindings: [{ role: "roles/viewer", members: ["user:a@example.com"] }],
    };
    expect(
      applyIamMemberChange(policy, "roles/viewer", "user:a@example.com", "add"),
    ).toBeUndefined();
    expect(
      applyIamMemberChange(
        policy,
        "roles/viewer",
        "user:b@example.com",
        "remove",
      ),
    ).toBeUndefined();
  });
});
