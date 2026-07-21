"use client";

import { Copy, KeyRound, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

type ApiKeySummary = {
  id: string;
  name: string;
  keyPrefix: string;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  notes: string | null;
  usage: {
    calls: number;
    jobs: number;
    failedJobs: number;
    openRouterCost: number;
    avgDurationMs: number | null;
  };
};

type UsageSummary = {
  totals: {
    calls: number;
    jobs: number;
    failures: number;
    failedJobs: number;
    openRouterCost: number;
    avgDurationMs: number | null;
  };
  daily: Array<{
    day: string;
    calls: number;
    jobs: number;
    failures: number;
    openRouterCost: number;
  }>;
  routes: Array<{
    route: string;
    method: string;
    calls: number;
    failures: number;
    openRouterCost: number;
    avgDurationMs: number | null;
  }>;
};

export default function AdminPage() {
  const [adminToken, setAdminToken] = useState(() =>
    typeof window === "undefined" ? "" : (window.localStorage.getItem("filedrop_admin_token") ?? ""),
  );
  const [keyName, setKeyName] = useState("Study app");
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [createdKey, setCreatedKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const activeKeys = useMemo(() => keys.filter((key) => key.status === "active").length, [keys]);

  async function loadDashboard(token = adminToken) {
    if (!token) {
      setError("Enter the admin token.");
      return;
    }

    setLoading(true);
    setError("");
    window.localStorage.setItem("filedrop_admin_token", token);

    try {
      const [keysResponse, usageResponse] = await Promise.all([
        adminFetch("/api/admin/api-keys", token),
        adminFetch("/api/admin/usage", token),
      ]);

      const keysPayload = (await keysResponse.json()) as { keys?: ApiKeySummary[] };
      const usagePayload = (await usageResponse.json()) as UsageSummary;
      setKeys(keysPayload.keys ?? []);
      setUsage(usagePayload);
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError.message : "Could not load admin dashboard.");
    } finally {
      setLoading(false);
    }
  }

  async function createKey() {
    if (!keyName.trim()) {
      setError("Key name is required.");
      return;
    }

    setLoading(true);
    setError("");
    setCreatedKey("");

    try {
      const response = await adminFetch("/api/admin/api-keys", adminToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: keyName.trim() }),
      });
      const payload = (await response.json()) as { key: { key: string } };
      setCreatedKey(payload.key.key);
      await loadDashboard(adminToken);
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError.message : "Could not create key.");
    } finally {
      setLoading(false);
    }
  }

  async function revokeKey(keyId: string) {
    setLoading(true);
    setError("");

    try {
      await adminFetch(`/api/admin/api-keys/${encodeURIComponent(keyId)}`, adminToken, {
        method: "DELETE",
      });
      await loadDashboard(adminToken);
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError.message : "Could not revoke key.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#f7f6f2] px-4 py-6 text-zinc-950 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-7xl gap-5">
        <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-normal">fileDrop API</h1>
              <p className="mt-1 text-sm text-zinc-500">Create client keys and track calls, jobs, failures, and OpenRouter spend.</p>
            </div>
            <button
              type="button"
              onClick={() => void loadDashboard()}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </button>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
            <input
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              type="password"
              placeholder="Admin token"
              className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            />
            <button
              type="button"
              onClick={() => void loadDashboard()}
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              Unlock
            </button>
          </div>

          {error ? <p className="mt-3 rounded-md bg-rose-50 p-3 text-sm text-rose-700">{error}</p> : null}
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="Active keys" value={activeKeys} />
          <Metric label="Calls" value={usage?.totals.calls ?? 0} />
          <Metric label="Jobs" value={usage?.totals.jobs ?? 0} />
          <Metric label="Failures" value={usage?.totals.failures ?? 0} />
          <Metric label="OpenRouter" value={`$${(usage?.totals.openRouterCost ?? 0).toFixed(6)}`} />
        </section>

        <section className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold">Create API key</h2>
          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_180px]">
            <input
              value={keyName}
              onChange={(event) => setKeyName(event.target.value)}
              className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm outline-none focus:border-zinc-500"
              placeholder="Key name"
            />
            <button
              type="button"
              onClick={() => void createKey()}
              disabled={loading || !adminToken}
              className="inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <KeyRound className="h-4 w-4" />
              Create
            </button>
          </div>

          {createdKey ? (
            <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-medium text-amber-950">New key shown once</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="max-w-full overflow-auto rounded-md bg-white px-2 py-1 text-xs text-zinc-800">
                  {createdKey}
                </code>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(createdKey)}
                  className="inline-flex items-center gap-2 rounded-md border border-amber-300 px-2 py-1 text-xs font-medium text-amber-950 hover:bg-amber-100"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.9fr)]">
          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold">API keys</h2>
            <div className="mt-4 overflow-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="text-xs uppercase text-zinc-500">
                  <tr>
                    <th className="border-b border-zinc-200 py-2 pr-3">Name</th>
                    <th className="border-b border-zinc-200 py-2 pr-3">Prefix</th>
                    <th className="border-b border-zinc-200 py-2 pr-3">Calls</th>
                    <th className="border-b border-zinc-200 py-2 pr-3">Jobs</th>
                    <th className="border-b border-zinc-200 py-2 pr-3">Failed</th>
                    <th className="border-b border-zinc-200 py-2 pr-3">Cost</th>
                    <th className="border-b border-zinc-200 py-2 pr-3">Status</th>
                    <th className="border-b border-zinc-200 py-2" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.id}>
                      <td className="border-b border-zinc-100 py-3 pr-3 font-medium">{key.name}</td>
                      <td className="border-b border-zinc-100 py-3 pr-3 font-mono text-xs">{key.keyPrefix}...</td>
                      <td className="border-b border-zinc-100 py-3 pr-3">{key.usage.calls}</td>
                      <td className="border-b border-zinc-100 py-3 pr-3">{key.usage.jobs}</td>
                      <td className="border-b border-zinc-100 py-3 pr-3">{key.usage.failedJobs}</td>
                      <td className="border-b border-zinc-100 py-3 pr-3">${key.usage.openRouterCost.toFixed(6)}</td>
                      <td className="border-b border-zinc-100 py-3 pr-3">
                        <span className={`rounded-md px-2 py-1 text-xs font-medium ${key.status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-600"}`}>
                          {key.status}
                        </span>
                      </td>
                      <td className="border-b border-zinc-100 py-3">
                        <button
                          type="button"
                          onClick={() => void revokeKey(key.id)}
                          disabled={loading || key.status !== "active"}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-40"
                          aria-label={`Revoke ${key.name}`}
                          title="Revoke"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold">Routes</h2>
            <div className="mt-4 grid gap-2">
              {(usage?.routes ?? []).map((route) => (
                <div key={`${route.method}-${route.route}`} className="rounded-md bg-zinc-50 p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs">{route.method} {route.route}</span>
                    <span className="font-medium">{route.calls}</span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {route.failures} failures, ${route.openRouterCost.toFixed(6)}, {route.avgDurationMs ?? 0} ms avg
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs uppercase text-zinc-500">{label}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
    </div>
  );
}

async function adminFetch(path: string, token: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(payload?.message ?? payload?.error ?? "Request failed.");
  }

  return response;
}
