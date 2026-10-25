import { AbsoluteFill } from "remotion";
import { progress } from "../anim.ts";
import { color, font } from "../theme.ts";

/** The compare page's "At a glance" table. */
const TOOLS = ["Alchemy", "SST", "Pulumi", "Terraform", "AWS CDK"];
const ROWS: [string, string[]][] = [
  [
    "Language",
    [
      "TypeScript + Effect",
      "TypeScript + Go",
      "TypeScript, Python, Go, C#, Java",
      "HCL",
      "TypeScript, Python, Java, C#, Go",
    ],
  ],
  [
    "Built on",
    [
      "Pure TypeScript, end to end",
      "Pulumi, mostly bridged Terraform providers",
      "A Go engine, many providers bridged from Terraform",
      "A Go engine and Go provider plugins",
      "CloudFormation, a managed engine inside AWS",
    ],
  ],
  [
    "Infrastructure and app code together",
    ["Yes, as typed Effects and Layers", "No", "No", "No", "No"],
  ],
  [
    "Permissions",
    [
      "Derived from the bindings your code uses",
      "Granted by link",
      "Unenforced",
      "Unenforced",
      "Granted by grant*() calls",
    ],
  ],
  ["Runs locally", ["Emulated on your machine", "No, it deploys to the cloud", "No", "No", "No"]],
  [
    "Tests against real infrastructure",
    ["Deploy, assert, destroy from your test runner", "No", "No", "No", "No"],
  ],
];
const LABEL = 300;
const COL = (1680 - LABEL) / TOOLS.length;

export const Glance = ({ t }: { t: number }) => (
  <AbsoluteFill>
    <div
      style={{
        position: "absolute",
        left: 120 + LABEL,
        top: 230,
        width: COL,
        height: 790,
        borderRadius: 14,
        background: `color-mix(in srgb, ${color.moss} 10%, transparent)`,
      }}
    />
    {TOOLS.map((tool, k) => (
      <div
        key={tool}
        style={{
          position: "absolute",
          left: 120 + LABEL + k * COL + 20,
          top: 250,
          fontFamily: font.serif,
          fontWeight: 600,
          fontSize: 32,
          color: k === 0 ? color.moss : color.fg,
        }}
      >
        {tool}
      </div>
    ))}
    {ROWS.map(([label, cells], r) => (
      <div
        key={label}
        style={{
          position: "absolute",
          left: 120,
          top: 320 + r * 115,
          width: 1680,
          height: 115,
          borderTop: `1px solid ${color.hairline}`,
          opacity: progress(t, r * 5, 10),
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 18,
            width: LABEL - 30,
            fontFamily: font.sans,
            fontWeight: 600,
            fontSize: 22,
            color: color.fg,
          }}
        >
          {label}
        </div>
        {cells.map((cell, k) => (
          <div
            key={k}
            style={{
              position: "absolute",
              left: LABEL + k * COL + 20,
              top: 18,
              width: COL - 40,
              fontFamily: font.sans,
              fontSize: 21,
              lineHeight: 1.4,
              color:
                k === 0
                  ? color.fg
                  : cell.startsWith("No") || cell === "Unenforced"
                    ? "#6f6656"
                    : color.muted,
            }}
          >
            {cell}
          </div>
        ))}
      </div>
    ))}
  </AbsoluteFill>
);
