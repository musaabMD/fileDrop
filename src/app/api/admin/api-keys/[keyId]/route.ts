import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";
import { nowIso } from "@/lib/server/jobs";

type RouteContext = {
  params: Promise<{ keyId: string }>;
};

export async function DELETE(request: Request, context: RouteContext) {
  const unauthorized = requireAdmin(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { keyId } = await context.params;

  try {
    const { DB } = await getBindings();
    const timestamp = nowIso();
    await DB.prepare(
      "UPDATE api_keys SET status = 'revoked', revoked_at = ?, last_used_at = last_used_at WHERE id = ?",
    )
      .bind(timestamp, keyId)
      .run();

    return NextResponse.json({ keyId, status: "revoked", revokedAt: timestamp });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Could not revoke API key.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}
