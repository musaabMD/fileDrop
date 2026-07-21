import { NextResponse } from "next/server";
import type { FileDropD1Database } from "@/lib/server/cloudflare-bindings";
import { nowIso } from "@/lib/server/jobs";

export type ApiKeyRow = {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  notes: string | null;
};

export type ApiAuthContext = {
  apiKeyId: string | null;
  apiKeyName: string | null;
  authenticated: boolean;
};

export type UsageEventInput = {
  apiKeyId: string | null;
  jobId?: string | null;
  route: string;
  method: string;
  statusCode: number;
  durationMs: number;
  requestBytes?: number | null;
  responseBytes?: number | null;
  openrouterCost?: number | null;
  meta?: unknown;
};

export function requireAdmin(request: Request) {
  const adminToken = process.env.ADMIN_TOKEN;

  if (!adminToken) {
    return NextResponse.json({ error: "Admin token is not configured." }, { status: 503 });
  }

  if (getBearerToken(request) !== adminToken) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  return null;
}

export async function authenticateApiKey(request: Request, db: FileDropD1Database) {
  const token = getBearerToken(request);
  const keyRequired = String(process.env.REQUIRE_API_KEY) === "true";

  if (!token) {
    if (!keyRequired) {
      return { apiKeyId: null, apiKeyName: null, authenticated: false } satisfies ApiAuthContext;
    }

    return NextResponse.json({ error: "Missing API key." }, { status: 401 });
  }

  const keyHash = await hashSecret(token);
  const key = await db
    .prepare<ApiKeyRow>("SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'")
    .bind(keyHash)
    .first<ApiKeyRow>();

  if (!key) {
    return NextResponse.json({ error: "Invalid API key." }, { status: 401 });
  }

  await db
    .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
    .bind(nowIso(), key.id)
    .run();

  return {
    apiKeyId: key.id,
    apiKeyName: key.name,
    authenticated: true,
  } satisfies ApiAuthContext;
}

export async function createApiKeyRecord(
  db: FileDropD1Database,
  input: { name: string; notes?: string | null },
) {
  const rawKey = `fd_live_${randomBase64Url(32)}`;
  const keyPrefix = rawKey.slice(0, 16);
  const keyHash = await hashSecret(rawKey);
  const keyId = crypto.randomUUID();
  const timestamp = nowIso();

  await db
    .prepare(
      `INSERT INTO api_keys (
        id, name, key_prefix, key_hash, status, created_at, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(keyId, input.name, keyPrefix, keyHash, "active", timestamp, input.notes ?? null)
    .run();

  return {
    id: keyId,
    name: input.name,
    key: rawKey,
    keyPrefix,
    status: "active" as const,
    createdAt: timestamp,
  };
}

export async function recordUsageEvent(db: FileDropD1Database, input: UsageEventInput) {
  await db
    .prepare(
      `INSERT INTO api_usage_events (
        id, api_key_id, job_id, route, method, status_code, duration_ms,
        request_bytes, response_bytes, openrouter_cost, meta_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.apiKeyId,
      input.jobId ?? null,
      input.route,
      input.method,
      input.statusCode,
      input.durationMs,
      input.requestBytes ?? null,
      input.responseBytes ?? null,
      input.openrouterCost ?? null,
      input.meta === undefined ? null : JSON.stringify(input.meta),
      nowIso(),
    )
    .run();
}

export function getBearerToken(request: Request) {
  const header = request.headers.get("authorization");

  if (!header) {
    return null;
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

export function requestByteLength(request: Request) {
  const value = request.headers.get("content-length");
  const parsed = value ? Number(value) : null;
  return Number.isFinite(parsed) ? parsed : null;
}

export function estimateJsonBytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function sumOpenRouterCost(value: unknown): number | null {
  const costs: number[] = [];
  collectCosts(value, costs);
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  return costs.length ? total : null;
}

async function hashSecret(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomBase64Url(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function collectCosts(value: unknown, costs: number[]) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectCosts(item, costs));
    return;
  }

  const record = value as Record<string, unknown>;
  const cost = record.cost ?? record.total_cost;

  if (typeof cost === "number" && Number.isFinite(cost)) {
    costs.push(cost);
  }

  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      collectCosts(child, costs);
    }
  }
}
