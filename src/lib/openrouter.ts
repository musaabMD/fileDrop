import { pageExtractionSchema, type PageExtraction } from "@/lib/extraction-schema";

const PAGE_EXTRACTION_PROMPT_VERSION = "exam-semantic-layout-v2";

type ExtractPageInput = {
  fileName: string;
  pageNumber: number;
  width: number;
  height: number;
  nativeText: string;
  imageDataUrl: string;
};

class OpenRouterError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

function getOpenRouterConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new OpenRouterError("OPENROUTER_API_KEY is not configured.");
  }

  return {
    apiKey,
    model: process.env.OPENROUTER_MODEL_PAGE_EXTRACTION ?? "google/gemini-2.5-flash",
    siteUrl: process.env.OPENROUTER_SITE_URL ?? "https://filedrop.local",
    appName: process.env.OPENROUTER_APP_NAME ?? "fileDrop",
  };
}

function stripJsonFence(value: string) {
  const trimmed = value.trim();

  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function buildPrompt(input: ExtractPageInput) {
  return `
You are a high-precision exam-document extraction engine.

The supplied page may contain zero, one, or multiple questions, typed recall text, screenshots containing questions, answer choices, answer keys, editor comments, explanations, Arabic text, English text, images, medical scans, laboratory results, tables, charts, hyperlinks, watermarks, headings, and unrelated content.

Your job is not to summarize the page. Reconstruct the page's semantic structure while preserving exact source evidence.

Rules:
- Do not assume one page equals one question.
- Preserve original spelling and grammar in source versions.
- Do not invent missing source text.
- Do not generate new questions during extraction.
- Associate only semantically relevant visual assets.
- If choices or answers conflict, mark the question as needs_review or incomplete.
- Bounding boxes must be page-relative pixels for a rendered image of ${input.width}x${input.height}.
- Return valid JSON only.

Return this JSON shape:
{
  "schemaVersion": "1.0",
  "page": { "pageNumber": ${input.pageNumber}, "width": ${input.width}, "height": ${input.height}, "extractedText": string | null },
  "regions": [{ "id": string, "type": string, "rawText": string | null, "normalizedText": string | null, "boundingBox": { "x": number, "y": number, "width": number, "height": number }, "confidence": number, "associatedQuestionId": string | null }],
  "assets": [{ "id": string, "questionId": string | null, "pageNumber": ${input.pageNumber}, "role": string, "boundingBox": { "x": number, "y": number, "width": number, "height": number }, "containsText": boolean, "rawTranscription": string | null, "normalizedTranscription": string | null, "confidence": number }],
  "questions": [{
    "id": string,
    "origin": "extracted" | "reconstructed" | "generated",
    "source": { "pageNumbers": [${input.pageNumber}], "regionIds": string[], "evidenceIds": string[] },
    "versions": {
      "source": { "stem": string | null, "choices": [{ "id": string, "label": string | null, "text": string, "orderIndex": number, "boundingBox": object | null }] },
      "normalized": { "stem": string, "choices": [{ "id": string, "label": string | null, "text": string, "orderIndex": number, "boundingBox": object | null }] },
      "quizReady": { "stem": string, "choices": [{ "id": string, "label": string | null, "text": string, "orderIndex": number, "boundingBox": object | null }] }
    },
    "answer": { "correctChoiceId": string | null, "sourceChoiceLabel": string | null, "status": string, "rawAnswerText": string | null, "evidenceIds": string[], "confidence": number },
    "assets": string[],
    "completeness": { "stemComplete": boolean, "choicesComplete": boolean, "minimumChoiceCountMet": boolean, "imageRequired": boolean, "imagePresentWhenRequired": boolean, "answerPresent": boolean, "hasConflictingEvidence": boolean, "missingParts": string[], "score": number },
    "usabilityStatus": "quiz_ready" | "needs_review" | "incomplete" | "reference_only" | "not_a_question",
    "confidence": { "segmentation": number, "stem": number, "choices": number, "answer": number, "imageAssociation": number, "duplicateResolution": number, "overall": number },
    "warnings": string[],
    "reviewStatus": "unreviewed" | "approved" | "edited" | "rejected" | "review_required"
  }],
  "warnings": string[]
}

Native text extracted from ${input.fileName}, page ${input.pageNumber}:
${input.nativeText.slice(0, 12000)}
`;
}

async function requestOpenRouter(
  input: ExtractPageInput,
  attempt = 0,
): Promise<PageExtraction> {
  const config = getOpenRouterConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

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
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `Prompt version: ${PAGE_EXTRACTION_PROMPT_VERSION}. Return machine-validated JSON only.`,
          },
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt(input) },
              { type: "image_url", image_url: { url: input.imageDataUrl } },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new OpenRouterError(body || response.statusText, response.status);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;

    if (!content) {
      throw new OpenRouterError("OpenRouter returned no message content.");
    }

    const parsed = JSON.parse(stripJsonFence(content));
    return pageExtractionSchema.parse(parsed);
  } catch (error) {
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** attempt));
      return requestOpenRouter(input, attempt + 1);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractPage(input: ExtractPageInput) {
  return requestOpenRouter(input);
}
