import { brand, mono } from "../theme.ts";
import { Caption, Em, Rise, Scene } from "../ui.tsx";

const TIERS = [
  {
    name: "Proved",
    color: brand.moss,
    what: "for every state and every input, after any number of commands",
    rules: ["Account.NeverOverdrawn", "Account.AClosedAccountStaysClosed"],
  },
  {
    name: "Checked",
    color: brand.gold,
    what: "in every sequence of up to 2 commands, with every delivery fault",
    rules: ["Bank.TransfersLoseNoMoney", "Bank.NoTransferLeftPending"],
  },
  {
    name: "Sampled",
    color: brand.sky,
    what: "in 200 longer sequences of up to 12 commands",
    rules: ["none breaks a rule"],
  },
  {
    name: "Assumed",
    color: brand.fgMuted,
    what: "what a pass takes for granted, listed by name",
    rules: ["middleware lets every caller in", "a decision commits everywhere or nowhere"],
  },
] as const;

/** The report: how far each rule is known to hold. */
export const Report = ({ length }: { length: number }) => (
  <Scene kicker="The report" title="Each rule says how far it is known to hold" length={length}>
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {TIERS.map((tier, index) => (
        <Rise key={tier.name} at={14 + index * 34}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 30,
              borderLeft: `8px solid ${tier.color}`,
              background: brand.bgElevated,
              borderRadius: 14,
              padding: "18px 28px",
            }}
          >
            <div style={{ width: 210, fontSize: 40, fontWeight: 700, color: tier.color }}>
              {tier.name}
            </div>
            <div style={{ flex: 1, fontSize: 26, color: brand.fg }}>{tier.what}</div>
            <div style={{ width: 620, fontFamily: mono, fontSize: 20, color: brand.fgMuted }}>
              {tier.rules.map((rule) => (
                <div key={rule}>
                  {tier.name === "Assumed" ? "- " : "✓ "}
                  {rule}
                </div>
              ))}
            </div>
          </div>
        </Rise>
      ))}
    </div>
    <Caption at={170}>
      A pass means the whole check was done. Code that could not be read, a policy left out, or a
      rule no sequence reached <Em>fails the test</Em>, with the file, line and reason.
    </Caption>
  </Scene>
);
