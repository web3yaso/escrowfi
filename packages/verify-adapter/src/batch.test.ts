import { describe, expect, it } from "vitest";
import { loadDemoBatch } from "./batch.js";
import { makeSaVerifier } from "./index.js";
import { FIXTURE_PAYEE } from "./vendor/testing/sa-fixture.js";

const NOW = () => new Date("2026-08-03T00:00:00.000Z").getTime();

describe("operator-signed SA batch (real Deal Desk key)", () => {
  it("every operator SA verifies against the batch operator address", async () => {
    const batch = loadDemoBatch();
    const verify = makeSaVerifier({
      registeredSigners: [batch.operatorAddress], sas: batch.sas, now: NOW,
    });
    for (const saHash of batch.sas.keys()) {
      const verdict = await verify({ saHash, payee: FIXTURE_PAYEE, amount: 1n });
      if (saHash === batch.badSaHash) {
        expect(verdict.ok).toBe(false);
      } else {
        expect(verdict.ok).toBe(true);
        expect(verdict.signer?.toLowerCase()).toBe(batch.operatorAddress.toLowerCase());
      }
    }
  });

  it("carries exactly one rogue fixture for the rejection demo", () => {
    const batch = loadDemoBatch();
    expect(batch.sas.size).toBe(4);
    expect(batch.agentId).toBe("854638");
  });
});
