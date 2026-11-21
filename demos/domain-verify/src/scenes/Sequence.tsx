import { brand, mono } from "../theme.ts";
import { Code, Panel, Rise, Scene } from "../ui.tsx";

const BANK = `export class Bank extends Domain.Model("Bank", {
  aggregates: [Account, Transfer],
  policies: [PayIn, Refund],
  invariants: {
    TransfersLoseNoMoney: (bank) =>
      taken(bank) === paidIn(bank) + paidBack(bank),
  },
}) {}`;

const STEPS = [
  { text: "StartTransfer { from: a, to: b, amount: 5 }", color: brand.fg },
  { text: "CloseAccount { id: b }", color: brand.fg },
  { text: "PayIn is refused: b is closed", color: brand.gold },
  { text: "Refund is delivered twice", color: brand.gold },
  { text: "✗ a is paid back 10 for 5 taken", color: brand.ember },
] as const;

/** Rules about the whole model: every short sequence of commands, with every delivery fault. */
export const Sequence = ({ length }: { length: number }) => (
  <Scene kicker="5 · The whole model" title="Then it tries every order of commands" length={length}>
    <div style={{ display: "flex", gap: 40, alignItems: "flex-start" }}>
      <Panel title="Bank.model.ts" style={{ flex: 1 }}>
        <Code code={BANK} at={4} every={2} size={23} marks={[{ lines: [3, 4, 5, 6], from: 40 }]} />
      </Panel>
      <div style={{ flex: 1 }}>
        {STEPS.map((step, index) => (
          <Rise key={step.text} at={70 + index * 20}>
            <div
              style={{
                display: "flex",
                gap: 18,
                alignItems: "center",
                fontFamily: mono,
                fontSize: 23,
                color: step.color,
                background: brand.bgElevated,
                border: `1px solid ${index === STEPS.length - 1 ? brand.ember : brand.border}`,
                borderRadius: 12,
                padding: "11px 20px",
                marginBottom: 10,
              }}
            >
              <span style={{ color: brand.fgMuted }}>{index + 1}</span>
              {step.text}
            </div>
          </Rise>
        ))}
      </div>
    </div>
    <Rise at={176} style={{ fontSize: 30, color: brand.fgMuted, marginTop: 26, maxWidth: 1100 }}>
      Policies and sagas react along the way.
      <br />
      Their messages are dropped, repeated and reordered.
    </Rise>
  </Scene>
);
