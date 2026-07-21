import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateApiKey,
  estimateJsonBytes,
  recordUsageEvent,
  requestByteLength,
} from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";

const transformSchema = z.object({
  mode: z.enum(["rag_markdown", "chapter_summary", "high_yield", "table_to_markdown", "qa"]),
  text: z.string().min(1),
  question: z.string().max(2000).optional(),
  instructions: z.string().max(2000).optional(),
});
type TransformMode = z.infer<typeof transformSchema>["mode"];

function getConfig() {
  if (String(process.env.ENABLE_AI_CLEANUP) !== "true") {
    throw new Error("Text AI is disabled.");
  }

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  return {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL_CLEANUP ?? "google/gemini-2.5-flash",
    siteUrl: process.env.OPENROUTER_SITE_URL ?? "https://filedrop.mousab-r.workers.dev",
    appName: process.env.OPENROUTER_APP_NAME ?? "fileDrop",
    maxChars: Number(process.env.MAX_AI_TEXT_CHARS ?? 60_000),
  };
}

function buildPrompt(input: z.infer<typeof transformSchema>, text: string) {
  const modeInstructions = {
    rag_markdown:
      "Convert the source into clean Markdown for retrieval augmented generation. Preserve headings, page markers, lists, tables, definitions, and image/table placeholders. Do not add unsupported facts.",
    chapter_summary:
      "Create a concise chapter summary with headings, key concepts, clinical pearls, and exam-relevant takeaways. Stay grounded only in the source.",
    high_yield:
      "Extract high-yield facts, quick-hit boxes, warnings, definitions, and exam pearls. Return grouped Markdown bullets with source wording preserved where possible.",
    table_to_markdown:
      "Extract table-like content into clean GitHub-flavored Markdown tables. If the input is not enough for a table, return the best structured Markdown and mark uncertainty.",
    qa: "Answer the user's question using only the provided source. Cite page markers or headings when present. If the source does not contain the answer, say so.",
  } satisfies Record<TransformMode, string>;

  return `
${modeInstructions[input.mode]}

Extra instructions:
${input.instructions ?? "None"}

Question:
${input.question ?? "None"}

Source:
${text}

Return JSON only:
{
  "markdown": "result markdown",
  "warnings": [],
  "confidence": 0.0
}
`;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const { DB } = await getBindings();
  const auth = await authenticateApiKey(request, DB);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const parsed = transformSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid transform request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const config = getConfig();
    const text = parsed.data.text.slice(0, Math.max(1000, config.maxChars));
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.siteUrl,
        "X-Title": config.appName,
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: buildPrompt(parsed.data, text) }],
      }),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "OpenRouter transform failed.", message: await response.text() },
        { status: 502 },
      );
    }

    const payload = (await response.json()) as {
      model?: string;
      usage?: Record<string, unknown>;
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      return NextResponse.json({ error: "OpenRouter returned no content." }, { status: 502 });
    }

    const output = JSON.parse(stripJsonFence(content)) as unknown;
    const usage = payload.usage ?? null;
    const cost = readUsageCost(usage);

    const responsePayload = {
      mode: parsed.data.mode,
      model: payload.model ?? config.model,
      output,
      usage,
      cost,
      truncated: parsed.data.text.length > text.length,
    };

    await recordUsageEvent(DB, {
      apiKeyId: auth.apiKeyId,
      route: "/api/transform",
      method: "POST",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestBytes: requestByteLength(request),
      responseBytes: estimateJsonBytes(responsePayload),
      openrouterCost: cost,
      meta: {
        authenticated: auth.authenticated,
        mode: parsed.data.mode,
        model: payload.model ?? config.model,
        truncated: parsed.data.text.length > text.length,
      },
    });

    return NextResponse.json(responsePayload);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Text transform unavailable.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}

function readUsageCost(usage: unknown) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const record = usage as Record<string, unknown>;
  const value = record.cost ?? record.total_cost;
  return typeof value === "number" ? value : null;
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}
