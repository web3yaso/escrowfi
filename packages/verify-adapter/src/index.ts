/**
 * Adapter: `@citely/verifier`'s stateless SA checks → the pool's injected
 * `SaVerifier` port. The pool verifies locally — it trusts no remote service,
 * including the SA issuer's own. Signature check only for the MVP (module
 * attestation + rubric coverage need the deal-desk manifest assets; roadmap).
 */
import { checkDeliverableSignature } from "./vendor/checks/signature.js";
import { computeDeliverableHash } from "./vendor/sa/index.js";
import type { SettlementAuthorization } from "./vendor/sa/index.js";
import { privateKeyToAccount } from "viem/accounts";
import type { Address } from "viem";
import { fixtureSa } from "./vendor/testing/sa-fixture.js";
import type { SaVerifier } from "@citely-pay/pool";

export function makeSaVerifier(opts: {
  registeredSigners: readonly Address[];
  sas: ReadonlyMap<string, SettlementAuthorization>;
}): SaVerifier {
  return async ({ saHash }) => {
    const sa = opts.sas.get(saHash);
    if (!sa) return { ok: false, reason: "sa_not_found" };
    const outcome = await checkDeliverableSignature({
      sa,
      registeredSigners: opts.registeredSigners,
    });
    if (!outcome.passed) {
      const reason = outcome.failures[0]?.code ?? "signature_check_failed";
      return { ok: false, reason };
    }
    return { ok: true, signer: opts.registeredSigners[0] as string };
  };
}

/** Demo fixture set: 3 valid SAs (inv-1..3) + 1 signed by an unregistered key. */
export async function demoFixtures(): Promise<{
  sas: Map<string, SettlementAuthorization>;
  signers: Address[];
  badSaHash: string;
}> {
  const registered = privateKeyToAccount(`0x${"7".repeat(64)}`);
  const rogue = privateKeyToAccount(`0x${"8".repeat(64)}`);
  const sas = new Map<string, SettlementAuthorization>();
  for (const jobId of ["11", "12", "13"]) {
    const sa = await fixtureSa({
      account: registered,
      body: { bound_to: { job_id: jobId, expires_at: "2027-01-01T00:00:00.000Z" } },
    });
    sas.set(computeDeliverableHash(sa), sa);
  }
  const bad = await fixtureSa({
    account: rogue,
    body: { bound_to: { job_id: "14", expires_at: "2027-01-01T00:00:00.000Z" } },
  });
  const badSaHash = computeDeliverableHash(bad);
  sas.set(badSaHash, bad);
  return { sas, signers: [registered.address], badSaHash };
}
