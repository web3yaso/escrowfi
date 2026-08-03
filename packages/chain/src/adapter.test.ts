import { describe, expect, it } from "vitest";
import { makeSimulatedAdapter, pickAdapter } from "./index.js";

describe("simulated chain adapter", () => {
  it("returns deterministic simulated- txHashes and labels the explorer url", async () => {
    const chain = makeSimulatedAdapter();
    const a = await chain.transferUsdc({ to: "0x1111111111111111111111111111111111111111", amount: 5n, memo: "escrow-inv-1" });
    const b = await chain.transferUsdc({ to: "0x1111111111111111111111111111111111111111", amount: 5n, memo: "payout-a1" });
    expect(a.txHash).toBe("simulated-1-escrow-inv-1");
    expect(b.txHash).toBe("simulated-2-payout-a1");
    expect(chain.explorerUrl(a.txHash)).toBe("#simulated");
  });
});

describe("pickAdapter", () => {
  it("defaults to simulated", () => {
    expect(pickAdapter({}).mode).toBe("simulated");
  });
  it("arc mode requires all four env vars", () => {
    expect(() => pickAdapter({ CHAIN_MODE: "arc" })).toThrow(/ARC_RPC_URL/);
  });
  it("an unknown CHAIN_MODE fails closed instead of silently simulating", () => {
    expect(() => pickAdapter({ CHAIN_MODE: "ARC" })).toThrow(/unknown CHAIN_MODE/);
  });
});
