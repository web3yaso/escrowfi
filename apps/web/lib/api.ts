/** bigint-safe JSON responses + uniform error mapping for route handlers. */

export function jsonBig(data: unknown, status = 200): Response {
  const body = JSON.stringify(data, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  return new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  return (await req.json()) as Record<string, unknown>;
}

export function asBigint(v: unknown, field: string): bigint {
  if (typeof v === "string" || typeof v === "number") return BigInt(v);
  throw new Error(`${field} must be a numeric string`);
}

export function asStr(v: unknown, field: string): string {
  if (typeof v === "string" && v.length > 0) return v;
  throw new Error(`${field} required`);
}

/** Caller-bug errors → 400; unexpected → 500. Route handlers wrap with this. */
export async function handling(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|must be|unknown |exceeds|mismatch|already|no pending|escrowed/.test(message) ? 400 : 500;
    return jsonBig({ error: message }, status);
  }
}
