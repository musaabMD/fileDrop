import { NextResponse } from "next/server";
import { z } from "zod";
import {
  authenticateApiKey,
  estimateJsonBytes,
  recordUsageEvent,
  requestByteLength,
} from "@/lib/server/api-auth";
import { getBindings } from "@/lib/server/cloudflare-bindings";

const cleanupQuestionSchema = z.object({
  id: z.string().min(1),
  pageNumbers: z.array(z.number().int().positive()).max(4),
  stem: z.string().max(3000),
  choices: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().nullable(),
        text: z.string().max(600),
      }),
    )
    .max(8),
});

const requestSchema = z.object({
  questions: z.array(cleanupQuestionSchema).max(500),
});

const cleanupResponseSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string(),
      keep: z.boolean(),
      stem: z.string(),
      choices: z.array(
        z.object({
          id: z.string(),
          label: z.string().nullable(),
          text: z.string(),
          keep: z.boolean(),
        }),
      ),
      reviewStatus: z.enum(["approved", "review_required", "rejected"]),
      usabilityStatus: z.enum(["quiz_ready", "needs_review", "incomplete", "not_a_question"]),
      warnings: z.array(z.string()),
    }),
  ),
});

function getConfig() {
  if (String(process.env.ENABLE_AI_CLEANUP) !== "true") {
    throw new Error("AI cleanup is disabled.");
  }

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not configured.");
  }

  return {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL_CLEANUP ?? "google/gemini-2.5-flash",
    siteUrl: process.env.OPENROUTER_SITE_URL ?? "https://filedrop.mousab-r.workers.dev",
    appName: process.env.OPENROUTER_APP_NAME ?? "fileDrop",
    maxQuestions: Number(process.env.MAX_AI_CLEANUP_QUESTIONS_PER_RUN ?? 20),
  };
}

function buildPrompt(questions: z.infer<typeof cleanupQuestionSchema>[]) {
  return `
You clean multiple-choice question extraction results.

Rules:
- Keep only real exam questions.
- Reject cover pages, table of contents, credits, Telegram/group attribution, section indexes, notes explaining how to use the document, and specialty category lists.
- Remove choices that are not actual answer options.
- Do not answer the questions.
- Do not add medical facts.
- Preserve the source stem wording. Do not summarize, shorten, paraphrase, or remove clinical details from stems.
- If uncertain, keep the item but mark review_required and add a short warning.
- Return JSON only.

Input:
${JSON.stringify({ questions })}

Return:
{
  "questions": [
    {
      "id": "same id",
      "keep": true,
      "stem": "cleaned stem",
      "choices": [{"id":"same id","label":"A","text":"cleaned choice","keep":true}],
      "reviewStatus": "approved" | "review_required" | "rejected",
      "usabilityStatus": "quiz_ready" | "needs_review" | "incomplete" | "not_a_question",
      "warnings": []
    }
  ]
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

  const parsed = requestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid cleanup request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const config = getConfig();
    const questions = parsed.data.questions.slice(0, Math.max(0, config.maxQuestions));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25_000);

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
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
          messages: [
            {
              role: "user",
              content: buildPrompt(questions),
            },
          ],
        }),
      });

      if (!response.ok) {
        return NextResponse.json(
          { error: "OpenRouter cleanup failed.", message: await response.text() },
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
        return NextResponse.json(
          { error: "OpenRouter cleanup returned no content." },
          { status: 502 },
        );
      }

      const cleaned = cleanupResponseSchema.parse(JSON.parse(stripJsonFence(content)));
      const usage = payload.usage ?? null;
      const responsePayload = {
        ...cleaned,
        model: payload.model ?? config.model,
        usage,
        cost: readUsageCost(usage),
      };

      await recordUsageEvent(DB, {
        apiKeyId: auth.apiKeyId,
        route: "/api/cleanup-questions",
        method: "POST",
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        requestBytes: requestByteLength(request),
        responseBytes: estimateJsonBytes(responsePayload),
        openrouterCost: responsePayload.cost,
        meta: {
          authenticated: auth.authenticated,
          model: payload.model ?? config.model,
          questions: questions.length,
        },
      });

      return NextResponse.json(responsePayload);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return NextResponse.json(
      {
        error: "AI cleanup unavailable.",
        message: error instanceof Error ? error.message : "Unknown error.",
      },
      { status: 503 },
    );
  }
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function readUsageCost(usage: unknown) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  const record = usage as Record<string, unknown>;
  const value = record.cost ?? record.total_cost;
  return typeof value === "number" ? value : null;
}
