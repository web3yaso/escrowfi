/**
 * The demo SA batch, minted inside the Deal Desk repo with its REAL operator
 * key (the key never left that repo). Trust root: the operator address must
 * match `ownerOf(agentId)` on the ERC-8004 Identity Registry on Arc testnet —
 * resolve it live with `resolveRegisteredSigner` instead of trusting this file.
 */
import { createPublicClient, http, parseAbi } from "viem";
import type { Address } from "viem";
import type { SettlementAuthorization } from "./vendor/sa/index.js";
import saBatchJson from "../fixtures/sa-batch.json" with { type: "json" };

export const ERC8004_REGISTRY: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const DEAL_DESK_AGENT_ID = 854638n;

interface SaBatchFile {
  agentId: string;
  operatorAddress: Address;
  sas: { saHash: string; sa: SettlementAuthorization; provenance: string }[];
}

export function loadDemoBatch(): {
  sas: Map<string, SettlementAuthorization>;
  operatorAddress: Address;
  badSaHash: string;
  agentId: string;
} {
  const batch = saBatchJson as unknown as SaBatchFile;
  const sas = new Map(batch.sas.map((e) => [e.saHash, e.sa]));
  const bad = batch.sas.find((e) => e.provenance === "rogue-unregistered");
  if (!bad) throw new Error("sa batch is missing the rogue rejection fixture");
  return { sas, operatorAddress: batch.operatorAddress, badSaHash: bad.saHash, agentId: batch.agentId };
}

/** ownerOf(agentId) on the on-chain registry — the demo's actual trust root. */
export async function resolveRegisteredSigner(opts?: {
  rpcUrl?: string;
  registry?: Address;
  agentId?: bigint;
}): Promise<Address> {
  const client = createPublicClient({
    transport: http(opts?.rpcUrl ?? "https://rpc.testnet.arc.network"),
  });
  return client.readContract({
    address: opts?.registry ?? ERC8004_REGISTRY,
    abi: parseAbi(["function ownerOf(uint256) view returns (address)"]),
    functionName: "ownerOf",
    args: [opts?.agentId ?? DEAL_DESK_AGENT_ID],
  });
}
