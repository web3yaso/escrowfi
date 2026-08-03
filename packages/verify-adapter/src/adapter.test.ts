import { describe, expect, it } from "vitest";
import { demoFixtures, makeSaVerifier } from "./index.js";

describe("makeSaVerifier over real signed SA fixtures", () => {
  it("verifies a fixture SA and recovers the signer", async () => {
    const fx = await demoFixtures();
    const verify = makeSaVerifier({ registeredSigners: fx.signers, sas: fx.sas });
    const [saHash] = [...fx.sas.keys()].filter((h) => h !== fx.badSaHash);
    const verdict = await verify({ saHash: saHash!, payee: "0xany", amount: 1n });
    expect(verdict.ok).toBe(true);
    expect(verdict.signer?.toLowerCase()).toBe(fx.signers[0]!.toLowerCase());
  });

  it("rejects an SA signed by an unregistered key with a machine reason", async () => {
    const fx = await demoFixtures();
    const verify = makeSaVerifier({ registeredSigners: fx.signers, sas: fx.sas });
    const verdict = await verify({ saHash: fx.badSaHash, payee: "0xany", amount: 1n });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBeTruthy();
  });

  it("rejects an unknown saHash as sa_not_found", async () => {
    const fx = await demoFixtures();
    const verify = makeSaVerifier({ registeredSigners: fx.signers, sas: fx.sas });
    const verdict = await verify({ saHash: "0xdeadbeef", payee: "0xany", amount: 1n });
    expect(verdict).toEqual({ ok: false, reason: "sa_not_found" });
  });

  it("provides three good invoiced SAs for the demo", async () => {
    const fx = await demoFixtures();
    expect(fx.sas.size).toBe(4); // 3 good + 1 bad
  });
});
