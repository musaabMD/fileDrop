import { describe, expect, it } from "vitest";
import { pageExtractionSchema } from "./extraction-schema";

describe("pageExtractionSchema", () => {
  it("accepts a valid extracted question payload", () => {
    const parsed = pageExtractionSchema.parse({
      schemaVersion: "1.0",
      page: { pageNumber: 1, width: 1000, height: 1400, extractedText: "Q1" },
      regions: [],
      assets: [],
      questions: [
        {
          id: "q1",
          origin: "extracted",
          source: { pageNumbers: [1], regionIds: [], evidenceIds: [] },
          versions: {
            source: { stem: "Which option is correct?", choices: [] },
            normalized: { stem: "Which option is correct?", choices: [] },
            quizReady: { stem: "Which option is correct?", choices: [] },
          },
          answer: {
            correctChoiceId: null,
            sourceChoiceLabel: null,
            status: "missing",
            rawAnswerText: null,
            evidenceIds: [],
            confidence: 0,
          },
          assets: [],
          completeness: {
            stemComplete: true,
            choicesComplete: false,
            minimumChoiceCountMet: false,
            imageRequired: false,
            imagePresentWhenRequired: true,
            answerPresent: false,
            hasConflictingEvidence: false,
            missingParts: ["choices"],
            score: 0.4,
          },
          usabilityStatus: "needs_review",
          confidence: {
            segmentation: 0.8,
            stem: 0.9,
            choices: 0.1,
            answer: 0,
            imageAssociation: 1,
            duplicateResolution: 1,
            overall: 0.5,
          },
          warnings: [],
          reviewStatus: "review_required",
        },
      ],
      warnings: [],
    });

    expect(parsed.questions[0]?.id).toBe("q1");
  });

  it("rejects confidence values outside 0-1", () => {
    expect(() =>
      pageExtractionSchema.parse({
        schemaVersion: "1.0",
        page: { pageNumber: 1, width: 1000, height: 1400, extractedText: null },
        regions: [
          {
            id: "r1",
            type: "question_stem",
            rawText: "bad confidence",
            normalizedText: "bad confidence",
            boundingBox: { x: 0, y: 0, width: 100, height: 100 },
            confidence: 2,
            associatedQuestionId: null,
          },
        ],
        assets: [],
        questions: [],
        warnings: [],
      }),
    ).toThrow();
  });
});
