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

const REGION_TYPE_MAP: Record<string, string> = {
  answer: "answer_key",
  answers: "answer_key",
  answer_choice: "answer_choices",
  answer_choices_region: "answer_choices",
  answer_option: "answer_choices",
  choice: "answer_choices",
  choices: "answer_choices",
  option: "answer_choices",
  options: "answer_choices",
  question: "question_stem",
  question_text: "question_stem",
  stem: "question_stem",
  image: "question_image",
  screenshot: "screenshot_question",
  note: "editor_comment",
  notes: "editor_comment",
  comment: "editor_comment",
};

const ANSWER_STATUS_MAP: Record<string, string> = {
  confirmed: "editor_confirmed",
  correct: "explicit",
  correct_answer: "explicit",
  detected: "explicit",
  found: "explicit",
  given: "explicit",
  provided: "explicit",
  explicit_answer: "explicit",
  unknown: "missing",
  none: "missing",
  not_found: "missing",
  ambiguous: "uncertain",
};

const ASSET_ROLE_MAP: Record<string, string> = {
  image: "part_of_question",
  question_image: "part_of_question",
  screenshot: "contains_question_text",
  answer_choices: "contains_question_text",
  explanation: "answer_explanation",
  reference: "reference_material",
  lab: "laboratory_result",
  decorative_image: "decorative",
};

const REGION_TYPES = new Set([
  "question_stem",
  "answer_choices",
  "answer_key",
  "question_image",
  "screenshot_question",
  "reference_image",
  "explanation",
  "editor_comment",
  "heading",
  "footer",
  "watermark",
  "link",
  "table",
  "chart",
  "laboratory_result",
  "medical_image",
  "formula",
  "non_question_content",
  "unknown",
]);

const ANSWER_STATUSES = new Set([
  "explicit",
  "editor_confirmed",
  "inferred",
  "conflicting",
  "missing",
  "uncertain",
]);

const ASSET_ROLES = new Set([
  "required_to_answer",
  "part_of_question",
  "contains_question_text",
  "answer_explanation",
  "reference_material",
  "laboratory_result",
  "medical_image",
  "table",
  "chart",
  "decorative",
  "watermark",
  "unrelated",
  "uncertain",
]);

const QUESTION_ORIGINS = new Set(["extracted", "reconstructed", "generated"]);
const USABILITY_STATUSES = new Set([
  "quiz_ready",
  "needs_review",
  "incomplete",
  "reference_only",
  "not_a_question",
]);
const REVIEW_STATUSES = new Set([
  "unreviewed",
  "approved",
  "edited",
  "rejected",
  "review_required",
]);

function clampConfidence(value: unknown, fallback = 0.5) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, value));
}

function normalizeEnum(value: unknown, map: Record<string, string>, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  return map[normalized] ?? normalized;
}

function normalizeAllowedEnum(
  value: unknown,
  map: Record<string, string>,
  allowed: Set<string>,
  fallback: string,
) {
  const normalized = normalizeEnum(value, map, fallback);
  return allowed.has(normalized) ? normalized : fallback;
}

function normalizeBoundingBox(value: unknown, width: number, height: number) {
  const box =
    value && typeof value === "object"
      ? (value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown })
      : {};
  const x = typeof box.x === "number" ? box.x : 0;
  const y = typeof box.y === "number" ? box.y : 0;
  const boxWidth = typeof box.width === "number" ? box.width : width;
  const boxHeight = typeof box.height === "number" ? box.height : Math.max(1, height * 0.12);

  return {
    x: Math.min(Math.max(0, x), Math.max(0, width - 1)),
    y: Math.min(Math.max(0, y), Math.max(0, height - 1)),
    width: Math.min(Math.max(1, boxWidth), width),
    height: Math.min(Math.max(1, boxHeight), height),
  };
}

function normalizeModelPayload(value: unknown, input: ExtractPageInput) {
  const payload =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};

  const regions = Array.isArray(payload.regions) ? payload.regions : [];
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const questions = Array.isArray(payload.questions) ? payload.questions : [];

  return {
    schemaVersion: "1.0",
    page: {
      pageNumber: input.pageNumber,
      width: input.width,
      height: input.height,
      extractedText:
        typeof (payload.page as { extractedText?: unknown } | undefined)?.extractedText === "string"
          ? (payload.page as { extractedText: string }).extractedText
          : input.nativeText || null,
    },
    regions: regions.map((region, index) => {
      const item = region as Record<string, unknown>;
      return {
        id: typeof item.id === "string" && item.id ? item.id : `p${input.pageNumber}_r${index + 1}`,
        type: normalizeAllowedEnum(item.type, REGION_TYPE_MAP, REGION_TYPES, "unknown"),
        rawText: typeof item.rawText === "string" ? item.rawText : null,
        normalizedText: typeof item.normalizedText === "string" ? item.normalizedText : null,
        boundingBox: normalizeBoundingBox(item.boundingBox, input.width, input.height),
        confidence: clampConfidence(item.confidence),
        associatedQuestionId:
          typeof item.associatedQuestionId === "string" ? item.associatedQuestionId : null,
      };
    }),
    assets: assets.map((asset, index) => {
      const item = asset as Record<string, unknown>;
      return {
        id: typeof item.id === "string" && item.id ? item.id : `p${input.pageNumber}_a${index + 1}`,
        questionId: typeof item.questionId === "string" ? item.questionId : null,
        pageNumber: input.pageNumber,
        role: normalizeAllowedEnum(item.role, ASSET_ROLE_MAP, ASSET_ROLES, "uncertain"),
        boundingBox: normalizeBoundingBox(item.boundingBox, input.width, input.height),
        containsText: typeof item.containsText === "boolean" ? item.containsText : false,
        rawTranscription: typeof item.rawTranscription === "string" ? item.rawTranscription : null,
        normalizedTranscription:
          typeof item.normalizedTranscription === "string" ? item.normalizedTranscription : null,
        confidence: clampConfidence(item.confidence),
      };
    }),
    questions: questions.map((question, index) => normalizeQuestion(question, input, index)),
    warnings: Array.isArray(payload.warnings)
      ? payload.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
  };
}

function normalizeQuestion(value: unknown, input: ExtractPageInput, index: number) {
  const question = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const versions = question.versions as
    | {
        source?: { stem?: unknown; choices?: unknown };
        normalized?: { stem?: unknown; choices?: unknown };
        quizReady?: { stem?: unknown; choices?: unknown };
      }
    | undefined;
  const sourceStem =
    typeof versions?.source?.stem === "string"
      ? versions.source.stem
      : typeof versions?.quizReady?.stem === "string"
        ? versions.quizReady.stem
        : "";
  const normalizedStem =
    typeof versions?.normalized?.stem === "string" ? versions.normalized.stem : sourceStem;
  const quizReadyStem =
    typeof versions?.quizReady?.stem === "string" ? versions.quizReady.stem : normalizedStem;
  const choices =
    normalizeChoices(versions?.quizReady?.choices) ||
    normalizeChoices(versions?.normalized?.choices) ||
    normalizeChoices(versions?.source?.choices) ||
    [];
  const answer = question.answer as Record<string, unknown> | undefined;
  const answerSourceChoiceLabel =
    typeof answer?.sourceChoiceLabel === "string" ? answer.sourceChoiceLabel : null;
  const answerRawText = typeof answer?.rawAnswerText === "string" ? answer.rawAnswerText : null;
  const answerCorrectChoiceId =
    typeof answer?.correctChoiceId === "string"
      ? answer.correctChoiceId
      : answerSourceChoiceLabel
        ? choices.find((choice) => choice.label === answerSourceChoiceLabel)?.id ?? null
        : null;
  const normalizedAnswerStatus = normalizeAllowedEnum(
    answer?.status,
    ANSWER_STATUS_MAP,
    ANSWER_STATUSES,
    "missing",
  );
  const answerStatus =
    normalizedAnswerStatus === "missing" && (answerCorrectChoiceId || answerSourceChoiceLabel || answerRawText)
      ? "explicit"
      : normalizedAnswerStatus;
  const completeness = question.completeness as Record<string, unknown> | undefined;
  const confidence = question.confidence as Record<string, unknown> | undefined;
  const id =
    typeof question.id === "string" && question.id ? question.id : `p${input.pageNumber}_q${index + 1}`;

  return {
    id,
    origin: normalizeAllowedEnum(question.origin, {}, QUESTION_ORIGINS, "extracted"),
    source: {
      pageNumbers: [input.pageNumber],
      regionIds: Array.isArray((question.source as { regionIds?: unknown } | undefined)?.regionIds)
        ? ((question.source as { regionIds: string[] }).regionIds ?? []).filter(
            (regionId): regionId is string => typeof regionId === "string",
          )
        : [],
      evidenceIds: Array.isArray((question.source as { evidenceIds?: unknown } | undefined)?.evidenceIds)
        ? ((question.source as { evidenceIds: string[] }).evidenceIds ?? []).filter(
            (evidenceId): evidenceId is string => typeof evidenceId === "string",
          )
        : [],
    },
    versions: {
      source: { stem: sourceStem || null, choices },
      normalized: { stem: normalizedStem || sourceStem || "Review source question", choices },
      quizReady: { stem: quizReadyStem || normalizedStem || sourceStem || "Review source question", choices },
    },
    answer: {
      correctChoiceId: answerCorrectChoiceId,
      sourceChoiceLabel: answerSourceChoiceLabel,
      status: answerStatus,
      rawAnswerText: answerRawText,
      evidenceIds: Array.isArray(answer?.evidenceIds)
        ? answer.evidenceIds.filter((evidenceId): evidenceId is string => typeof evidenceId === "string")
        : [],
      confidence: clampConfidence(answer?.confidence, 0),
    },
    assets: Array.isArray(question.assets)
      ? question.assets.filter((assetId): assetId is string => typeof assetId === "string")
      : [],
    completeness: {
      stemComplete: typeof completeness?.stemComplete === "boolean" ? completeness.stemComplete : Boolean(quizReadyStem),
      choicesComplete: typeof completeness?.choicesComplete === "boolean" ? completeness.choicesComplete : choices.length >= 2,
      minimumChoiceCountMet:
        typeof completeness?.minimumChoiceCountMet === "boolean" ? completeness.minimumChoiceCountMet : choices.length >= 2,
      imageRequired: typeof completeness?.imageRequired === "boolean" ? completeness.imageRequired : false,
      imagePresentWhenRequired:
        typeof completeness?.imagePresentWhenRequired === "boolean" ? completeness.imagePresentWhenRequired : true,
      answerPresent: typeof completeness?.answerPresent === "boolean" ? completeness.answerPresent : false,
      hasConflictingEvidence:
        typeof completeness?.hasConflictingEvidence === "boolean" ? completeness.hasConflictingEvidence : false,
      missingParts: Array.isArray(completeness?.missingParts)
        ? completeness.missingParts.filter((part): part is string => typeof part === "string")
        : choices.length >= 2
          ? []
          : ["choices"],
      score: clampConfidence(completeness?.score, choices.length >= 2 ? 0.75 : 0.45),
    },
    usabilityStatus: normalizeAllowedEnum(
      question.usabilityStatus,
      { usable: "quiz_ready", ready: "quiz_ready", review: "needs_review" },
      USABILITY_STATUSES,
      choices.length >= 2 ? "needs_review" : "incomplete",
    ),
    confidence: {
      segmentation: clampConfidence(confidence?.segmentation),
      stem: clampConfidence(confidence?.stem),
      choices: clampConfidence(confidence?.choices),
      answer: clampConfidence(confidence?.answer, 0),
      imageAssociation: clampConfidence(confidence?.imageAssociation),
      duplicateResolution: clampConfidence(confidence?.duplicateResolution),
      overall: clampConfidence(confidence?.overall),
    },
    warnings: Array.isArray(question.warnings)
      ? question.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    reviewStatus: normalizeAllowedEnum(
      question.reviewStatus,
      { needs_review: "review_required", review: "review_required" },
      REVIEW_STATUSES,
      "review_required",
    ),
  };
}

function normalizeChoices(value: unknown) {
  if (!Array.isArray(value)) {
    return null;
  }

  const choices = value
    .map((choice, index) => {
      const item = choice as Record<string, unknown>;
      const text = typeof item.text === "string" ? item.text.trim() : "";
      if (!text) {
        return null;
      }

      return {
        id: typeof item.id === "string" && item.id ? item.id : `choice_${index + 1}`,
        label: typeof item.label === "string" ? item.label : null,
        text,
        orderIndex: typeof item.orderIndex === "number" ? item.orderIndex : index,
        boundingBox:
          item.boundingBox && typeof item.boundingBox === "object"
            ? normalizeBoundingBox(item.boundingBox, 10_000, 10_000)
            : null,
      };
    })
    .filter((choice): choice is NonNullable<typeof choice> => Boolean(choice));

  return choices;
}

function fallbackFromNativeText(input: ExtractPageInput, warning: string): PageExtraction {
  const text = input.nativeText.replace(/\s+/g, " ").trim();
  const choiceMatches = Array.from(
    text.matchAll(/(?:^|\s)([A-H])[\).:-]\s*([^A-H]{1,180}?)(?=\s+[A-H][\).:-]|\s+Answer\b|$)/gi),
  );
  const choices = choiceMatches.map((match, index) => ({
    id: `p${input.pageNumber}_q1_c${index + 1}`,
    label: match[1]?.toUpperCase() ?? null,
    text: match[2]?.trim() || "Review choice",
    orderIndex: index,
    boundingBox: null,
  }));
  const answerMatch = text.match(/\b(?:answer|ans)\s*[:\-]?\s*([A-H])\b/i);
  const correctChoice = answerMatch
    ? choices.find((choice) => choice.label === answerMatch[1]?.toUpperCase())
    : null;
  const firstChoiceIndex = choiceMatches[0]?.index ?? -1;
  const stem = choices.length && firstChoiceIndex > 0
    ? text.slice(0, firstChoiceIndex).trim()
    : text;

  return {
    schemaVersion: "1.0",
    page: {
      pageNumber: input.pageNumber,
      width: input.width,
      height: input.height,
      extractedText: input.nativeText || null,
    },
    regions: text
      ? [
          {
            id: `p${input.pageNumber}_native_text`,
            type: choices.length ? "question_stem" : "non_question_content",
            rawText: text,
            normalizedText: text,
            boundingBox: { x: 0, y: 0, width: input.width, height: input.height },
            confidence: 0.45,
            associatedQuestionId: choices.length ? `p${input.pageNumber}_q1` : null,
          },
        ]
      : [],
    assets: [],
    questions:
      text && choices.length >= 2
        ? [
            {
              id: `p${input.pageNumber}_q1`,
              origin: "extracted",
              source: {
                pageNumbers: [input.pageNumber],
                regionIds: [`p${input.pageNumber}_native_text`],
                evidenceIds: [],
              },
              versions: {
                source: { stem, choices },
                normalized: { stem, choices },
                quizReady: { stem, choices },
              },
              answer: {
                correctChoiceId: correctChoice?.id ?? null,
                sourceChoiceLabel: answerMatch?.[1]?.toUpperCase() ?? null,
                status: answerMatch ? "explicit" : "missing",
                rawAnswerText: answerMatch?.[0] ?? null,
                evidenceIds: [],
                confidence: answerMatch ? 0.6 : 0,
              },
              assets: [],
              completeness: {
                stemComplete: Boolean(stem),
                choicesComplete: choices.length >= 2,
                minimumChoiceCountMet: choices.length >= 2,
                imageRequired: false,
                imagePresentWhenRequired: true,
                answerPresent: Boolean(answerMatch),
                hasConflictingEvidence: false,
                missingParts: answerMatch ? [] : ["answer"],
                score: answerMatch ? 0.65 : 0.5,
              },
              usabilityStatus: "needs_review",
              confidence: {
                segmentation: 0.45,
                stem: 0.45,
                choices: 0.55,
                answer: answerMatch ? 0.6 : 0,
                imageAssociation: 1,
                duplicateResolution: 1,
                overall: 0.5,
              },
              warnings: [warning],
              reviewStatus: "review_required",
            },
          ]
        : [],
    warnings: [warning],
  };
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
  const timeout = setTimeout(() => controller.abort(), 35_000);

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
    const normalized = normalizeModelPayload(parsed, input);
    return pageExtractionSchema.parse(normalized);
  } catch (error) {
    if (error instanceof OpenRouterError && attempt < 1) {
      await new Promise((resolve) => setTimeout(resolve, 700 * 2 ** attempt));
      return requestOpenRouter(input, attempt + 1);
    }

    return fallbackFromNativeText(
      input,
      error instanceof OpenRouterError
        ? `OpenRouter failed; native text fallback used.`
        : "OpenRouter response could not be validated; native text fallback used.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function extractPage(input: ExtractPageInput) {
  return requestOpenRouter(input);
}
