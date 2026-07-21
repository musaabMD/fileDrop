import { z } from "zod";

export const boundingBoxSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const regionTypeSchema = z.enum([
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

export const answerStatusSchema = z.enum([
  "explicit",
  "editor_confirmed",
  "inferred",
  "conflicting",
  "missing",
  "uncertain",
]);

export const assetRoleSchema = z.enum([
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

const confidence = z.number().min(0).max(1);

export const choiceSchema = z.object({
  id: z.string().min(1),
  label: z.string().nullable(),
  text: z.string().min(1),
  orderIndex: z.number().int().nonnegative(),
  boundingBox: boundingBoxSchema.nullable(),
});

export const pageRegionSchema = z.object({
  id: z.string().min(1),
  type: regionTypeSchema,
  rawText: z.string().nullable(),
  normalizedText: z.string().nullable(),
  boundingBox: boundingBoxSchema,
  confidence,
  associatedQuestionId: z.string().nullable(),
});

export const questionAssetSchema = z.object({
  id: z.string().min(1),
  questionId: z.string().nullable(),
  pageNumber: z.number().int().positive(),
  role: assetRoleSchema,
  boundingBox: boundingBoxSchema,
  containsText: z.boolean(),
  rawTranscription: z.string().nullable(),
  normalizedTranscription: z.string().nullable(),
  confidence,
});

export const canonicalQuestionSchema = z.object({
  id: z.string().min(1),
  origin: z.enum(["extracted", "reconstructed", "generated"]),
  source: z.object({
    pageNumbers: z.array(z.number().int().positive()),
    regionIds: z.array(z.string()),
    evidenceIds: z.array(z.string()),
  }),
  versions: z.object({
    source: z.object({
      stem: z.string().nullable(),
      choices: z.array(choiceSchema),
    }),
    normalized: z.object({
      stem: z.string(),
      choices: z.array(choiceSchema),
    }),
    quizReady: z.object({
      stem: z.string(),
      choices: z.array(choiceSchema),
    }),
  }),
  answer: z.object({
    correctChoiceId: z.string().nullable(),
    sourceChoiceLabel: z.string().nullable(),
    status: answerStatusSchema,
    rawAnswerText: z.string().nullable(),
    evidenceIds: z.array(z.string()),
    confidence,
  }),
  assets: z.array(z.string()),
  completeness: z.object({
    stemComplete: z.boolean(),
    choicesComplete: z.boolean(),
    minimumChoiceCountMet: z.boolean(),
    imageRequired: z.boolean(),
    imagePresentWhenRequired: z.boolean(),
    answerPresent: z.boolean(),
    hasConflictingEvidence: z.boolean(),
    missingParts: z.array(z.string()),
    score: confidence,
  }),
  usabilityStatus: z.enum([
    "quiz_ready",
    "needs_review",
    "incomplete",
    "reference_only",
    "not_a_question",
  ]),
  confidence: z.object({
    segmentation: confidence,
    stem: confidence,
    choices: confidence,
    answer: confidence,
    imageAssociation: confidence,
    duplicateResolution: confidence,
    overall: confidence,
  }),
  warnings: z.array(z.string()),
  reviewStatus: z.enum([
    "unreviewed",
    "approved",
    "edited",
    "rejected",
    "review_required",
  ]),
});

export const pageExtractionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  page: z.object({
    pageNumber: z.number().int().positive(),
    width: z.number().positive(),
    height: z.number().positive(),
    extractedText: z.string().nullable(),
  }),
  regions: z.array(pageRegionSchema),
  assets: z.array(questionAssetSchema),
  questions: z.array(canonicalQuestionSchema),
  warnings: z.array(z.string()),
});

export type BoundingBox = z.infer<typeof boundingBoxSchema>;
export type PageExtraction = z.infer<typeof pageExtractionSchema>;
export type CanonicalQuestion = z.infer<typeof canonicalQuestionSchema>;
export type QuestionAsset = z.infer<typeof questionAssetSchema> & {
  previewUrl?: string;
};
