"use client";

/* eslint-disable @next/next/no-img-element */

import {
  Check,
  Download,
  Filter,
  FileText,
  FileUp,
  Loader2,
  ThumbsDown,
  ThumbsUp,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  BoundingBox,
  CanonicalQuestion,
  PageExtraction,
  QuestionAsset,
} from "@/lib/extraction-schema";

type Phase = "idle" | "rendering" | "extracting" | "done" | "error";
type Tab = "review" | "markdown" | "assets" | "quiz" | "json";

type PageWork = {
  pageNumber: number;
  width: number;
  height: number;
  nativeText: string;
  imageDataUrl: string;
  imageBoxes: BoundingBox[];
};

type LocalAsset = QuestionAsset & {
  documentPageNumber: number;
  previewUrl?: string;
};

type QuizAnswer = Record<string, string>;
type MarkdownPage = {
  pageNumber: number;
  source: "native" | "ocr" | "empty";
  text: string;
};
type PageScreenshot = {
  pageNumber: number;
  imageDataUrl: string;
  width: number;
  height: number;
};
type ApiJob = {
  id: string;
  statusUrl: string;
  resultUrl: string;
  markdownUrl?: string | null;
  status?: string;
  reused?: boolean;
};
type AiUsageRecord = {
  provider: "openrouter";
  purpose: "cleanup";
  model?: string;
  cost?: number | null;
  usage?: unknown;
};

type FeedbackRating = "like" | "dislike";

const MAX_RENDER_WIDTH = 1050;
const IMAGE_QUALITY = 0.62;
const MAX_VISION_PAGES = 3;

function statusTone(status: CanonicalQuestion["usabilityStatus"]) {
  if (status === "quiz_ready") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (status === "needs_review") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (status === "incomplete") return "bg-rose-50 text-rose-700 ring-rose-200";
  return "bg-stone-100 text-stone-700 ring-stone-200";
}

function originTone(origin: CanonicalQuestion["origin"]) {
  if (origin === "extracted") return "bg-sky-50 text-sky-700 ring-sky-200";
  if (origin === "reconstructed") return "bg-violet-50 text-violet-700 ring-violet-200";
  return "bg-orange-50 text-orange-700 ring-orange-200";
}

function readFileBuffer(file: File) {
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read PDF."));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
}

async function fingerprintFile(file: File) {
  const bytes = await readFileBuffer(file);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  return {
    sourceHash: hash,
    sourceFingerprint: `${hash}:${file.size}:${file.name.toLowerCase()}`,
  };
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load rendered page."));
    image.src = src;
  });
}

async function cropAsset(
  imageDataUrl: string,
  pageWidth: number,
  pageHeight: number,
  box: BoundingBox,
) {
  const image = await loadImage(imageDataUrl);
  const xScale = image.naturalWidth / pageWidth;
  const yScale = image.naturalHeight / pageHeight;
  const canvas = document.createElement("canvas");
  const margin = 8;
  const sx = Math.max(0, (box.x - margin) * xScale);
  const sy = Math.max(0, (box.y - margin) * yScale);
  const sw = Math.min(image.naturalWidth - sx, (box.width + margin * 2) * xScale);
  const sh = Math.min(image.naturalHeight - sy, (box.height + margin * 2) * yScale);

  canvas.width = Math.max(1, Math.round(sw));
  canvas.height = Math.max(1, Math.round(sh));
  canvas.getContext("2d")?.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  return canvas.toDataURL("image/webp", 0.9);
}

async function detectVisualAssets(page: PageWork): Promise<LocalAsset[]> {
  if (page.imageBoxes.length) {
    return page.imageBoxes.map((box, index) => ({
      id: `p${page.pageNumber}_pdf_image_${index + 1}`,
      questionId: null,
      documentPageNumber: page.pageNumber,
      pageNumber: page.pageNumber,
      role: "part_of_question",
      boundingBox: box,
      containsText: false,
      rawTranscription: null,
      normalizedTranscription: null,
      confidence: 0.9,
    }));
  }

  const image = await loadImage(page.imageDataUrl);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  const cellSize = 16;

  if (!context) {
    return [];
  }

  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  context.drawImage(image, 0, 0);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const columns = Math.ceil(canvas.width / cellSize);
  const rows = Math.ceil(canvas.height / cellSize);
  const active = Array.from({ length: rows }, () => Array(columns).fill(false) as boolean[]);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      let nonWhite = 0;
      let total = 0;

      for (let y = row * cellSize; y < Math.min(canvas.height, (row + 1) * cellSize); y += 2) {
        for (let x = column * cellSize; x < Math.min(canvas.width, (column + 1) * cellSize); x += 2) {
          const offset = (y * canvas.width + x) * 4;
          const red = imageData.data[offset] ?? 255;
          const green = imageData.data[offset + 1] ?? 255;
          const blue = imageData.data[offset + 2] ?? 255;
          const isDark = red < 220 || green < 220 || blue < 220;
          const isColored = Math.max(red, green, blue) - Math.min(red, green, blue) > 35;

          if (isDark || isColored) {
            nonWhite += 1;
          }
          total += 1;
        }
      }

      active[row][column] = total > 0 && nonWhite / total > 0.18;
    }
  }

  const visited = Array.from({ length: rows }, () => Array(columns).fill(false) as boolean[]);
  const boxes: BoundingBox[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (!active[row][column] || visited[row][column]) {
        continue;
      }

      const queue: Array<[number, number]> = [[row, column]];
      visited[row][column] = true;
      let minRow = row;
      let maxRow = row;
      let minColumn = column;
      let maxColumn = column;

      while (queue.length) {
        const [currentRow, currentColumn] = queue.shift()!;
        minRow = Math.min(minRow, currentRow);
        maxRow = Math.max(maxRow, currentRow);
        minColumn = Math.min(minColumn, currentColumn);
        maxColumn = Math.max(maxColumn, currentColumn);

        for (const [nextRow, nextColumn] of [
          [currentRow - 1, currentColumn],
          [currentRow + 1, currentColumn],
          [currentRow, currentColumn - 1],
          [currentRow, currentColumn + 1],
        ]) {
          if (
            nextRow < 0 ||
            nextColumn < 0 ||
            nextRow >= rows ||
            nextColumn >= columns ||
            visited[nextRow][nextColumn] ||
            !active[nextRow][nextColumn]
          ) {
            continue;
          }

          visited[nextRow][nextColumn] = true;
          queue.push([nextRow, nextColumn]);
        }
      }

      const box = {
        x: Math.max(0, minColumn * cellSize - 6),
        y: Math.max(0, minRow * cellSize - 6),
        width: Math.min(canvas.width, (maxColumn - minColumn + 1) * cellSize + 12),
        height: Math.min(canvas.height, (maxRow - minRow + 1) * cellSize + 12),
      };

      const area = box.width * box.height;
      const aspect = box.width / box.height;
      const pageArea = canvas.width * canvas.height;
      const density = measureNonWhiteDensity(imageData, canvas.width, canvas.height, box);

      if (
        area > pageArea * 0.012 &&
        box.width > 90 &&
        box.height > 70 &&
        density > 0.14 &&
        aspect > 0.25 &&
        aspect < 8
      ) {
        boxes.push(box);
      }
    }
  }

  return mergeBoxes(boxes)
    .sort((a, b) => a.y - b.y)
    .slice(0, 8)
    .map((box, index) => ({
      id: `p${page.pageNumber}_visual_${index + 1}`,
      questionId: null,
      documentPageNumber: page.pageNumber,
      pageNumber: page.pageNumber,
      role: "part_of_question",
      boundingBox: box,
      containsText: false,
      rawTranscription: null,
      normalizedTranscription: null,
      confidence: 0.62,
    }));
}

type OperatorListPage = {
  getOperatorList: () => Promise<{
    fnArray: number[];
    argsArray: unknown[];
  }>;
};

type PdfViewport = {
  transform: number[];
};

async function extractPdfImageBoxes(
  page: OperatorListPage,
  viewport: PdfViewport,
  ops: Record<string, number>,
) {
  const operatorList = await page.getOperatorList();
  const boxes: BoundingBox[] = [];
  let currentTransform: number[] | null = null;

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    if (fn === ops.transform && Array.isArray(args) && args.length >= 6) {
      currentTransform = args.map(Number).slice(0, 6);
      continue;
    }

    if (
      (fn === ops.paintImageXObject ||
        fn === ops.paintJpegXObject ||
        fn === ops.paintInlineImageXObject) &&
      currentTransform
    ) {
      const [a, b, c, d, e, f] = currentTransform;
      if ([a, b, c, d, e, f].some((value) => !Number.isFinite(value))) {
        continue;
      }

      const left = Math.min(e, e + a + c);
      const right = Math.max(e, e + a + c);
      const bottom = Math.min(f, f + b + d);
      const top = Math.max(f, f + b + d);
      const topLeft = applyViewportTransform(viewport.transform, left, top);
      const bottomRight = applyViewportTransform(viewport.transform, right, bottom);
      const x1 = Math.min(topLeft.x, bottomRight.x);
      const y1 = Math.min(topLeft.y, bottomRight.y);
      const x2 = Math.max(topLeft.x, bottomRight.x);
      const y2 = Math.max(topLeft.y, bottomRight.y);
      const width = x2 - x1;
      const height = y2 - y1;

      if (width > 60 && height > 60) {
        boxes.push({
          x: Math.max(0, x1),
          y: Math.max(0, y1),
          width,
          height,
        });
      }
    }
  }

  return mergeBoxes(boxes).slice(0, 12);
}

function applyViewportTransform(transform: number[], x: number, y: number) {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = transform;

  return {
    x: a * x + c * y + e,
    y: b * x + d * y + f,
  };
}

function measureNonWhiteDensity(
  imageData: ImageData,
  canvasWidth: number,
  canvasHeight: number,
  box: BoundingBox,
) {
  let nonWhite = 0;
  let total = 0;
  const startX = Math.max(0, Math.floor(box.x));
  const startY = Math.max(0, Math.floor(box.y));
  const endX = Math.min(canvasWidth, Math.ceil(box.x + box.width));
  const endY = Math.min(canvasHeight, Math.ceil(box.y + box.height));

  for (let y = startY; y < endY; y += 3) {
    for (let x = startX; x < endX; x += 3) {
      const offset = (y * canvasWidth + x) * 4;
      const red = imageData.data[offset] ?? 255;
      const green = imageData.data[offset + 1] ?? 255;
      const blue = imageData.data[offset + 2] ?? 255;

      if (red < 225 || green < 225 || blue < 225) {
        nonWhite += 1;
      }
      total += 1;
    }
  }

  return total ? nonWhite / total : 0;
}

function mergeBoxes(boxes: BoundingBox[]) {
  const merged: BoundingBox[] = [];

  for (const box of boxes.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const match = merged.find((candidate) => boxesAreClose(candidate, box));

    if (!match) {
      merged.push({ ...box });
      continue;
    }

    const x1 = Math.min(match.x, box.x);
    const y1 = Math.min(match.y, box.y);
    const x2 = Math.max(match.x + match.width, box.x + box.width);
    const y2 = Math.max(match.y + match.height, box.y + box.height);

    match.x = x1;
    match.y = y1;
    match.width = x2 - x1;
    match.height = y2 - y1;
  }

  return merged;
}

function boxesAreClose(a: BoundingBox, b: BoundingBox) {
  const horizontalGap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
  const verticalGap = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height));
  const verticalOverlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);

  return (
    (horizontalGap < 36 && verticalGap < 36) ||
    (horizontalGap < 80 && verticalOverlap > Math.min(a.height, b.height) * 0.45)
  );
}

async function finalizeVisualAssets(page: PageWork, assets: LocalAsset[], questions: CanonicalQuestion[]) {
  const pageQuestions = questions.map((question) => ({ ...question, assets: [...question.assets] }));

  const finalizedAssets = await Promise.all(
    assets.map(async (asset, index) => {
      const targetQuestion = pickQuestionForAsset(pageQuestions, asset, index);
      const previewUrl = await cropAsset(
        page.imageDataUrl,
        page.width,
        page.height,
        asset.boundingBox,
      ).catch(() => undefined);

      if (targetQuestion && !targetQuestion.assets.includes(asset.id)) {
        targetQuestion.assets.push(asset.id);
      }

      return {
        ...asset,
        questionId: targetQuestion?.id ?? null,
        previewUrl,
      };
    }),
  );

  return { questions: pageQuestions, assets: finalizedAssets };
}

function pickQuestionForAsset(
  questions: CanonicalQuestion[],
  asset: LocalAsset,
  assetIndex: number,
) {
  if (!questions.length) {
    return null;
  }

  const imageQuestions = questions.filter((question) =>
    /\b(image|x-?ray|radiograph|ct|mri|ultrasound|scan|report|chest)\b/i.test(
      question.versions.quizReady.stem,
    ),
  );

  if (imageQuestions.length) {
    return imageQuestions[Math.min(assetIndex, imageQuestions.length - 1)];
  }

  const verticalRatio = asset.boundingBox.y / Math.max(1, asset.boundingBox.y + asset.boundingBox.height);
  const indexByPosition = Math.floor(verticalRatio * questions.length);
  return questions[Math.min(assetIndex, indexByPosition, questions.length - 1)] ?? questions[0];
}

async function renderPdfPages(
  file: File,
  onProgress: (page: number, total: number, label: string) => void,
  onPage: (page: PageWork, total: number) => Promise<void>,
) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const pdf = await pdfjs.getDocument({ data: await readFileBuffer(file) }).promise;

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    onProgress(pageNumber, pdf.numPages, "rendering page");
    const page = await pdf.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, MAX_RENDER_WIDTH / baseViewport.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      throw new Error("Canvas rendering is unavailable.");
    }

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: context, viewport }).promise;

    const textContent = await page.getTextContent();
    const nativeText = textContent.items
      .map((item) => {
        if (!("str" in item)) {
          return "";
        }

        return `${item.str}${"hasEOL" in item && item.hasEOL ? "\n" : " "}`;
      })
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const imageBoxes = await extractPdfImageBoxes(page, viewport, pdfjs.OPS).catch(() => []);

    await onPage({
      pageNumber,
      width: canvas.width,
      height: canvas.height,
      nativeText,
      imageDataUrl: canvas.toDataURL("image/jpeg", IMAGE_QUALITY),
      imageBoxes,
    }, pdf.numPages);
  }
}

async function extractPage(fileName: string, page: PageWork) {
  const response = await fetch("/api/extract-page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileName, ...page }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "Extraction failed.");
  }

  return (await response.json()) as PageExtraction;
}

async function ocrPage(imageDataUrl: string) {
  const { recognize } = await import("tesseract.js");
  const result = await recognize(imageDataUrl, "eng+ara");
  return result.data.text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pageToMarkdown(page: MarkdownPage) {
  const sourceLabel =
    page.source === "native"
      ? "native PDF text"
      : page.source === "ocr"
        ? "local OCR"
        : "no text";

  return [`## Page ${page.pageNumber}`, ``, `Source: ${sourceLabel}`, ``, page.text || "_No text extracted._"].join("\n");
}

function questionsToMarkdown(fileName: string, questions: CanonicalQuestion[]) {
  const lines = [`# ${fileName || "fileDrop extraction"}`, ""];

  if (!questions.length) {
    lines.push("_No MCQs extracted from selectable text._");
    return lines.join("\n");
  }

  questions.forEach((question, index) => {
    lines.push(`## Question ${index + 1}`, "");
    lines.push(question.versions.quizReady.stem, "");
    question.versions.quizReady.choices.forEach((choice) => {
      lines.push(`${choice.label ?? choice.orderIndex + 1}. ${choice.text}`);
    });
    lines.push("");
    lines.push(`Answer status: ${question.answer.status}`);
    if (question.answer.sourceChoiceLabel) {
      lines.push(`Answer: ${question.answer.sourceChoiceLabel}`);
    }
    lines.push(`Pages: ${question.source.pageNumbers.join(", ")}`, "");
  });

  return lines.join("\n");
}

function buildFullMarkdown(fileName: string, questions: CanonicalQuestion[], markdownPages: MarkdownPage[]) {
  return [
    questionsToMarkdown(fileName, questions),
    "",
    "---",
    "",
    "# Page Text",
    "",
    ...markdownPages.map(pageToMarkdown),
  ].join("\n");
}

function buildExportPayload({
  fileName,
  status,
  questions,
  assets,
  warnings,
  markdownPages,
  usage,
}: {
  fileName: string;
  status: string;
  questions: CanonicalQuestion[];
  assets: LocalAsset[];
  warnings: string[];
  markdownPages: MarkdownPage[];
  usage: AiUsageRecord[];
}) {
  return {
    schemaVersion: "1.0",
    document: {
      filename: fileName,
      status,
    },
    statistics: {
      totalQuestions: questions.length,
      quizReady: questions.filter((question) => question.usabilityStatus === "quiz_ready").length,
      needsReview: questions.filter((question) => question.usabilityStatus === "needs_review").length,
      extractedAssets: assets.length,
      pagesWithText: markdownPages.filter((page) => page.text.trim()).length,
    },
    questions,
    assets: assets.map((asset) => ({
      id: asset.id,
      questionId: asset.questionId,
      documentPageNumber: asset.documentPageNumber,
      pageNumber: asset.pageNumber,
      role: asset.role,
      boundingBox: asset.boundingBox,
      containsText: asset.containsText,
      rawTranscription: asset.rawTranscription,
      normalizedTranscription: asset.normalizedTranscription,
      confidence: asset.confidence,
      url: `/api/jobs/{jobId}/assets/${encodeURIComponent(asset.id)}`,
    })),
    pages: markdownPages,
    warnings,
    usage,
  };
}

function questionNeedsVisual(question: CanonicalQuestion) {
  return /\b(image|figure|attached|shown|x-?ray|radiograph|ct|mri|ultrasound|scan|ecg|ekg|histology|pathology|fundoscopy|cxr|chest\s*x-?ray)\b/i.test(
    question.versions.quizReady.stem,
  );
}

function shouldShowAssetWithQuestion(question: CanonicalQuestion, asset: LocalAsset) {
  if (
    [
      "required_to_answer",
      "medical_image",
      "laboratory_result",
      "table",
      "chart",
    ].includes(asset.role)
  ) {
    return true;
  }

  return questionNeedsVisual(question) && asset.role !== "contains_question_text";
}

function answerDisplayText(question: CanonicalQuestion) {
  if (!question.answer.sourceChoiceLabel) {
    return null;
  }

  const choice = question.versions.quizReady.choices.find(
    (item) => item.id === question.answer.correctChoiceId || item.label === question.answer.sourceChoiceLabel,
  );

  return choice
    ? `${question.answer.sourceChoiceLabel}. ${choice.text}`
    : question.answer.sourceChoiceLabel;
}

async function createApiJob(file: File, fingerprint: { sourceHash: string; sourceFingerprint: string }): Promise<ApiJob> {
  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      fileSize: file.size,
      contentType: file.type || "application/pdf",
      pageCount: undefined,
      sourceHash: fingerprint.sourceHash,
      sourceFingerprint: fingerprint.sourceFingerprint,
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "Could not create API job.");
  }

  const payload = (await response.json()) as {
    jobId: string;
    statusUrl: string;
    resultUrl: string;
    markdownUrl?: string | null;
    status?: string;
    reused?: boolean;
  };

  return {
    id: payload.jobId,
    statusUrl: payload.statusUrl,
    resultUrl: payload.resultUrl,
    markdownUrl: payload.markdownUrl ?? null,
    status: payload.status,
    reused: payload.reused,
  };
}

async function saveApiResult({
  jobId,
  resultJson,
  markdown,
  assets,
  usage,
  processingMs,
}: {
  jobId: string;
  resultJson: unknown;
  markdown: string;
  assets: LocalAsset[];
  usage: AiUsageRecord[];
  processingMs: number;
}) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/result`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      status: "completed",
      resultJson,
      markdown,
      usage,
      processingMs,
      stats:
        typeof resultJson === "object" && resultJson && "statistics" in resultJson
          ? (resultJson as { statistics: unknown }).statistics
          : undefined,
      assets: assets
        .filter((asset) => Boolean(asset.previewUrl))
        .map((asset) => ({
          id: asset.id,
          pageNumber: asset.documentPageNumber,
          questionId: asset.questionId,
          role: asset.role,
          contentType: dataUrlContentType(asset.previewUrl) ?? "image/webp",
          dataUrl: asset.previewUrl,
          width: Math.round(asset.boundingBox.width),
          height: Math.round(asset.boundingBox.height),
          boundingBox: asset.boundingBox,
        })),
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "Could not save API result.");
  }

  return (await response.json()) as { resultUrl: string; markdownUrl: string | null };
}

async function loadSavedJob(jobId: string) {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/result`);
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    throw new Error(payload?.message ?? payload?.error ?? "Could not load cached result.");
  }

  return (await response.json()) as {
    document?: { filename?: string };
    questions?: CanonicalQuestion[];
    assets?: Array<LocalAsset & { url?: string }>;
    pages?: MarkdownPage[];
    warnings?: string[];
    usage?: AiUsageRecord[];
  };
}

function dataUrlContentType(value?: string) {
  return value?.match(/^data:([^;,]+)/)?.[1] ?? null;
}

function extractNativeTextPage(page: PageWork): PageExtraction {
  const text = page.nativeText
    .split(/\n+/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const questionBlocks = splitQuestionBlocks(text);
  const questions = questionBlocks
    .map((block, index) => buildNativeQuestion(block, page, index))
    .filter((question): question is CanonicalQuestion => Boolean(question));

  return {
    schemaVersion: "1.0",
    page: {
      pageNumber: page.pageNumber,
      width: page.width,
      height: page.height,
      extractedText: text || null,
    },
    regions: text
      ? [
          {
            id: `p${page.pageNumber}_native_text`,
            type: questions.length ? "question_stem" : "non_question_content",
            rawText: text,
            normalizedText: text,
            boundingBox: { x: 0, y: 0, width: page.width, height: page.height },
            confidence: questions.length ? 0.72 : 0.35,
            associatedQuestionId: questions[0]?.id ?? null,
          },
        ]
      : [],
    assets: [],
    questions,
    warnings: questions.length
      ? []
      : text
        ? ["No clear text MCQ pattern found. Vision mode is off to prevent cost."]
        : ["No selectable text found. Vision mode is off to prevent cost."],
  };
}

function splitQuestionBlocks(text: string) {
  if (!text) {
    return [];
  }

  const recallBlocks = splitRecallLines(text);
  if (recallBlocks.length > 1) {
    return recallBlocks;
  }

  const paragraphBlocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.split(/\n/).filter(Boolean).length >= 3);

  if (paragraphBlocks.length > 1) {
    return paragraphBlocks;
  }

  const starts = Array.from(text.matchAll(/(?:^|\s)(?:Q(?:uestion)?\s*)?\d{1,3}[\).:-]\s+/gi))
    .map((match) => match.index ?? 0)
    .filter((index, position, array) => position === 0 || index !== array[position - 1]);

  if (starts.length <= 1) {
    return [text];
  }

  return starts.map((start, index) => text.slice(start, starts[index + 1] ?? text.length).trim());
}

function splitRecallLines(text: string) {
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isHeaderOrComment(line));
  const blocks: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (startsNewRecallBlock(line, current)) {
      blocks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length) {
    blocks.push(current);
  }

  return blocks
    .map((block) => block.join("\n"))
    .filter((block) => block.split(/\n/).length >= 3);
}

function startsNewRecallBlock(line: string, current: string[]) {
  if (current.length < 3 || isHeaderOrComment(line)) {
    return false;
  }

  const trailingChoices = collectTrailingChoices(current);
  const hasQuestionContext = current.some(looksLikeQuestionLine);
  if (trailingChoices.length < 2) {
    return false;
  }

  return hasQuestionContext && (looksLikeQuestionStartLine(line) || !looksLikeChoiceLine(line));
}

function buildNativeQuestion(
  block: string,
  page: PageWork,
  questionIndex: number,
): CanonicalQuestion | null {
  const choiceMatches = Array.from(
    block.matchAll(/(?:^|\s)([A-H])[\).:-]\s*([^A-H]{1,240}?)(?=\s+[A-H][\).:-]|\s+(?:Answer|Ans)\b|$)/gi),
  );

  if (choiceMatches.length >= 2) {
    return buildLabeledQuestion(block, page, questionIndex, choiceMatches);
  }

  return buildRecallStyleQuestion(block, page, questionIndex);
}

function buildLabeledQuestion(
  block: string,
  page: PageWork,
  questionIndex: number,
  choiceMatches: RegExpMatchArray[],
): CanonicalQuestion | null {
  const firstChoiceIndex = choiceMatches[0]?.index ?? -1;
  const stem = block
    .slice(0, firstChoiceIndex > 0 ? firstChoiceIndex : undefined)
    .replace(/^(?:Q(?:uestion)?\s*)?\d{1,3}[\).:-]\s*/i, "")
    .trim();

  if (!stem) {
    return null;
  }

  const questionId = `p${page.pageNumber}_q${questionIndex + 1}`;
  const answerFromBlock = extractAnswerFromLines(block.split(/\n+/));
  const choices = choiceMatches
    .map((match) => {
      const label = match[1]?.toUpperCase() ?? null;
      const text = cleanChoiceText(match[2]?.trim() || "", label);

      return { label, text };
    })
    .filter((choice) => choice.text && !isAnswerLine(choice.text) && !isCategoryChoice(choice.text))
    .map((choice, index) => ({
      id: `${questionId}_c${index + 1}`,
      label: choice.label,
      text: choice.text,
      orderIndex: index,
      boundingBox: null,
    }));

  if (!looksLikeRealExamStem(stem, choices.map((choice) => choice.text))) {
    return null;
  }

  return createNativeQuestion({
    page,
    questionIndex,
    stem,
    choices,
    answerLabel: answerFromBlock.label,
    answerRawText: answerFromBlock.rawText,
    answerUncertain: answerFromBlock.uncertain,
    confidence: answerFromBlock.label ? 0.82 : 0.72,
  });
}

function buildRecallStyleQuestion(
  block: string,
  page: PageWork,
  questionIndex: number,
): CanonicalQuestion | null {
  const lines = block
    .split(/\n+/)
    .map((line) => cleanOcrText(line).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isHeaderOrComment(line));

  if (lines.length < 3) {
    return null;
  }

  const answerFromBlock = extractAnswerFromLines(lines);
  const contentLines = answerFromBlock.lines;
  const questionEnd = contentLines.findIndex((line) => line.includes("?"));
  let stemLines: string[];
  let choiceLines: string[];
  let answerLabel = answerFromBlock.label;
  let answerRawText = answerFromBlock.rawText;
  let answerUncertain = answerFromBlock.uncertain;

  if (questionEnd >= 0 && contentLines.length - questionEnd - 1 >= 2) {
    stemLines = contentLines.slice(0, questionEnd + 1);
    choiceLines = contentLines.slice(questionEnd + 1);
  } else {
    const trailingChoices = collectTrailingChoices(contentLines);
    if (trailingChoices.length < 2 || trailingChoices.length >= contentLines.length) {
      return null;
    }

    stemLines = contentLines.slice(0, contentLines.length - trailingChoices.length);
    choiceLines = trailingChoices;
  }

  const inferredAnswer = inferAnswerFromRepeatedChoiceLines(choiceLines);
  if (!answerLabel && inferredAnswer) {
    answerLabel = inferredAnswer.label;
    answerRawText = inferredAnswer.rawText;
    answerUncertain = false;
    choiceLines = inferredAnswer.choiceLines;
  }

  choiceLines = dedupeChoiceTexts(trimDanglingTailChoices(choiceLines
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .map((line, index) => cleanChoiceText(line, String.fromCharCode(65 + index)))
    .filter((line) => line && !isHeaderOrComment(line) && !isAnswerLine(line) && !isCategoryChoice(line))
    .slice(0, 6)));

  if (choiceLines.length < 2 || !stemLines.join(" ").trim()) {
    return null;
  }

  const stem = stemLines.join(" ").replace(/^(?:Q(?:uestion)?\s*)?\d{1,4}[\).:-]\s*/i, "").trim();
  if (!looksLikeRealExamStem(stem, choiceLines)) {
    return null;
  }

  const choices = choiceLines.map((line, index) => ({
    id: `p${page.pageNumber}_q${questionIndex + 1}_c${index + 1}`,
    label: String.fromCharCode(65 + index),
    text: line,
    orderIndex: index,
    boundingBox: null,
  }));

  return createNativeQuestion({
    page,
    questionIndex,
    stem,
    choices,
    answerLabel,
    answerRawText,
    answerUncertain,
    confidence: answerLabel ? 0.78 : 0.68,
  });
}

function inferAnswerFromRepeatedChoiceLines(lines: string[]) {
  for (let candidateIndex = lines.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const rawText = lines[candidateIndex]?.trim() ?? "";
    if (!rawText || isHeaderOrComment(rawText)) {
      continue;
    }

    const labeled = parseLabeledChoiceLine(rawText);
    if (!labeled) {
      continue;
    }

    const expectedChoiceIndex = labeled.label.charCodeAt(0) - 65;
    const expectedRaw = lines[expectedChoiceIndex];
    const expectedText = expectedRaw
      ? cleanChoiceText(expectedRaw, labeled.label)
      : "";
    const duplicatedText = normalizeChoiceForDedupe(expectedText) === normalizeChoiceForDedupe(labeled.text);
    const duplicatedEarlier = lines
      .slice(0, candidateIndex)
      .some(
        (line, index) =>
          normalizeChoiceForDedupe(cleanChoiceText(line, String.fromCharCode(65 + index))) ===
          normalizeChoiceForDedupe(labeled.text),
      );

    if (!duplicatedText && !duplicatedEarlier) {
      continue;
    }

    return {
      label: labeled.label,
      rawText,
      choiceLines: lines.filter((_, index) => index !== candidateIndex),
    };
  }

  return null;
}

function parseLabeledChoiceLine(line: string) {
  const match = cleanOcrText(line).match(/^([A-H])[\).:-]\s*(.+)$/i);
  if (!match) {
    return null;
  }

  return {
    label: match[1].toUpperCase(),
    text: cleanChoiceText(match[2], match[1].toUpperCase()),
  };
}

function trimDanglingTailChoices(lines: string[]) {
  if (lines.length <= 4) {
    return lines;
  }

  const last = lines.at(-1)?.trim() ?? "";
  const previousChoices = lines.slice(0, -1);
  const looksLikePageBreakFragment =
    previousChoices.length >= 4 &&
    /^[A-Za-z]{3,18}$/.test(last) &&
    !/\b(type|stage|grade|class|group)\b/i.test(last);

  return looksLikePageBreakFragment ? previousChoices : lines;
}

function dedupeChoiceTexts(lines: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const line of lines) {
    const normalized = normalizeChoiceForDedupe(line);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(line);
  }

  return deduped;
}

function normalizeChoiceForDedupe(line: string) {
  return cleanOcrText(line)
    .toLowerCase()
    .replace(/^[a-h][\).:-]\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}.%/ -]/gu, "")
    .trim();
}

function collectTrailingChoices(lines: string[]) {
  const choices: string[] = [];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line || isHeaderOrComment(line) || looksLikeQuestionLine(line)) {
      break;
    }

    if (looksLikeChoiceLine(line)) {
      choices.unshift(line);
    } else {
      break;
    }
  }

  return choices.slice(-6);
}

function looksLikeChoiceLine(line: string) {
  const wordCount = line.split(/\s+/).length;
  return (
    line.length <= 110 &&
    wordCount <= 12 &&
    !/^(and|or|but)\b/i.test(line) &&
    !isAnswerLine(line) &&
    !isCategoryChoice(line)
  );
}

function looksLikeQuestionLine(line: string) {
  return (
    line.includes("?") ||
    /\b(what|which|best|most likely|diagnosis|management|treatment|next step|initial|confirm|responsible|target|level|cause|add)\b/i.test(line)
  );
}

function looksLikeRealExamStem(stem: string, choices: string[]) {
  const normalizedStem = stem.replace(/\s+/g, " ").trim();
  const normalizedChoices = choices.join(" ").replace(/\s+/g, " ");

  if (isNonQuestionStem(normalizedStem) || choices.some(isCategoryChoice)) {
    return false;
  }

  return (
    normalizedStem.includes("?") ||
    /\b(patient|woman|man|male|female|child|boy|girl|newborn|infant|pregnant|presents?|diagnosis|management|treatment|next step|most likely|appropriate|initial|confirm|screening|investigation|therapy|complication)\b/i.test(
      normalizedStem,
    ) ||
    /\b(allopurinol|hydroxyurea|transfusion|antibiotic|surgery|ocp|calcium|glucose|cortisol|metanephrines|ultrasound|ct|mri|x-?ray)\b/i.test(
      normalizedChoices,
    )
  );
}

function isNonQuestionStem(stem: string) {
  return (
    /Questions written by many/i.test(stem) ||
    /Collected\s*&\s*Edited by/i.test(stem) ||
    /\bTelegram\b|\bMOF Group\b/i.test(stem) ||
    /لا تنسوا|دعواتكم|بالتوفيق|التيسير/.test(stem) ||
    /\b(Family Medicine|Psychiatry|Statistics|Orthopedic|Radiology|Pediatric|Gynecology|Internal Medicine|Dermatology)\s+Questions\b/i.test(
      stem,
    )
  );
}

function isCategoryChoice(choice: string) {
  return (
    /^(?:[A-H]\s*)?(ENT|ER|Ophthalmology|General Surgery|Family Medicine|Psychiatry|Statistics|Orthopedic|Radiology|Pediatric|Gynecology|Internal Medicine|Dermatology)\s+Questions\b/i.test(
      choice,
    ) ||
    /^(?:[A-H]\s*)?(ENT|ER|Ophthalmology|General Surgery|Family Medicine|Psychiatry|Statistics|Orthopedic|Radiology|Pediatric|Gynecology|Internal Medicine|Dermatology)\s*:\s*$/i.test(
      choice,
    ) ||
    /^\(?\s*we are not sure of\s*\)?$/i.test(choice)
  );
}

function cleanOcrText(value: string) {
  return value
    .replace(/\u00d9/g, "ff")
    .replace(/\u00fb/g, "fi")
    .replace(/\u00f9/g, "fi")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanChoiceText(value: string, expectedLabel: string | null) {
  let text = cleanOcrText(value)
    .replace(/^[-*•]\s*/, "")
    .replace(/^\(?\s*([A-H])\s*\)?[\).:-]\s*/i, "")
    .trim();

  if (expectedLabel) {
    text = text.replace(new RegExp(`^${expectedLabel}\\s+[${expectedLabel}]?[\\).:-]?\\s*`, "i"), "").trim();
  }

  return text;
}

function parseAnswerLine(line: string) {
  const match = line.match(/^(?:answer|ans|correct\s+answer)\s*[:\-]?\s*([A-H])\??(?:\b|$)/i);

  if (!match) {
    return null;
  }

  return {
    label: match[1].toUpperCase(),
    rawText: line,
    uncertain: /\?|not sure|unsure/i.test(line),
  };
}

function isAnswerLine(line: string) {
  return Boolean(parseAnswerLine(cleanOcrText(line)));
}

function extractAnswerFromLines(lines: string[]) {
  let label: string | null = null;
  let rawText: string | null = null;
  let uncertain = false;
  const remaining: string[] = [];

  for (const line of lines) {
    const answer = parseAnswerLine(line);
    if (answer && !label) {
      label = answer.label;
      rawText = answer.rawText;
      uncertain = answer.uncertain;
      continue;
    }

    if (answer) {
      continue;
    }

    remaining.push(line);
  }

  return { lines: remaining, label, rawText, uncertain };
}

function looksLikeQuestionStartLine(line: string) {
  const normalized = line.replace(/\s+/g, " ").trim();

  return (
    /^(?:\d{1,4}[\).:-]\s*)?(?:a|an|the)?\s*(patient|woman|man|male|female|child|boy|girl|newborn|infant|pregnant|question|pt)\b/i.test(normalized) ||
    /^(?:\d{1,4}[\).:-]\s*)?\d{1,3}\s*(?:yo|y\/o|year\s*-?\s*old)\b/i.test(normalized) ||
    /^(?:\d{1,4}[\).:-]\s*)?a\s+\d{1,3}\s*-\s*year\s*-\s*old\b/i.test(normalized) ||
    /\b(presents?|present|came|coming|history|diagnosed|scheduled|asking|evaluated|complains|what|which|best|most likely)\b/i.test(normalized)
  );
}

function isHeaderOrComment(line: string) {
  return (
    /^April 15 2026 SMLE Morning Exam$/i.test(line) ||
    /^Tried to remember/i.test(line) ||
    /^The missing questions/i.test(line) ||
    /^Wish you all/i.test(line) ||
    /^Alhomrani:/i.test(line) ||
    /https?:\/\/|t\.me\/|Alhomrani/i.test(line) ||
    /^\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|July|Aug|Sep|Oct|Nov|Dec)\b/i.test(line) ||
    /Questions written by many/i.test(line) ||
    /Collected\s*&\s*Edited by/i.test(line) ||
    /\bTelegram\b|\bMOF Group\b/i.test(line) ||
    /^Notes?:/i.test(line)
  );
}

function createNativeQuestion({
  page,
  questionIndex,
  stem,
  choices,
  answerLabel,
  answerRawText,
  answerUncertain = false,
  confidence,
}: {
  page: PageWork;
  questionIndex: number;
  stem: string;
  choices: CanonicalQuestion["versions"]["quizReady"]["choices"];
  answerLabel: string | null;
  answerRawText: string | null;
  answerUncertain?: boolean;
  confidence: number;
}): CanonicalQuestion | null {
  if (!stem || choices.length < 2) {
    return null;
  }

  const questionId = `p${page.pageNumber}_q${questionIndex + 1}`;
  const normalizedChoices = choices.map((choice, index) => ({
    ...choice,
    id: choice.id || `${questionId}_c${index + 1}`,
    label: choice.label ?? String.fromCharCode(65 + index),
    orderIndex: index,
  }));
  const correctChoice = answerLabel
    ? normalizedChoices.find((choice) => choice.label === answerLabel)
    : null;
  const answerStatus = answerLabel ? (answerUncertain ? "uncertain" : "explicit") : "missing";

  return {
    id: questionId,
    origin: "extracted",
    source: {
      pageNumbers: [page.pageNumber],
      regionIds: [`p${page.pageNumber}_native_text`],
      evidenceIds: [],
    },
    versions: {
      source: { stem, choices: normalizedChoices },
      normalized: { stem, choices: normalizedChoices },
      quizReady: { stem, choices: normalizedChoices },
    },
    answer: {
      correctChoiceId: correctChoice?.id ?? null,
      sourceChoiceLabel: answerLabel,
      status: answerStatus,
      rawAnswerText: answerRawText,
      evidenceIds: [],
      confidence: answerLabel ? (answerUncertain ? 0.45 : 0.7) : 0,
    },
    assets: [],
    completeness: {
      stemComplete: true,
      choicesComplete: choices.length >= 2,
      minimumChoiceCountMet: choices.length >= 2,
      imageRequired: false,
      imagePresentWhenRequired: true,
      answerPresent: Boolean(answerLabel),
      hasConflictingEvidence: false,
      missingParts: answerLabel ? [] : ["answer"],
      score: confidence,
    },
    usabilityStatus: answerLabel && !answerUncertain ? "quiz_ready" : "needs_review",
    confidence: {
      segmentation: confidence,
      stem: confidence,
      choices: confidence,
      answer: answerLabel ? (answerUncertain ? 0.45 : 0.7) : 0,
      imageAssociation: 1,
      duplicateResolution: 1,
      overall: confidence,
    },
    warnings: [],
    reviewStatus: answerUncertain ? "review_required" : "review_required",
  };
}

type CleanupResponse = {
  questions: Array<{
    id: string;
    keep: boolean;
    stem: string;
    choices: Array<{
      id: string;
      label: string | null;
      text: string;
      keep: boolean;
    }>;
    reviewStatus: "approved" | "review_required" | "rejected";
    usabilityStatus: "quiz_ready" | "needs_review" | "incomplete" | "not_a_question";
    warnings: string[];
  }>;
  usage?: unknown;
  model?: string;
  cost?: number | null;
};

async function cleanupQuestionsWithAi(questions: CanonicalQuestion[]) {
  const response = await fetch("/api/cleanup-questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      questions: questions.map((question) => ({
        id: question.id,
        pageNumbers: question.source.pageNumbers,
        stem: question.versions.quizReady.stem,
        choices: question.versions.quizReady.choices.map((choice) => ({
          id: choice.id,
          label: choice.label,
          text: choice.text,
        })),
      })),
    }),
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? "AI cleanup failed.");
  }

  return (await response.json()) as CleanupResponse;
}

function applyCleanup(
  questions: CanonicalQuestion[],
  cleanup: CleanupResponse,
): CanonicalQuestion[] {
  const cleanupById = new Map(cleanup.questions.map((question) => [question.id, question]));

  return questions
    .map((question) => {
      const cleaned = cleanupById.get(question.id);
      if (!cleaned) {
        return question;
      }

      if (!cleaned.keep) {
        return {
          ...question,
          usabilityStatus: "not_a_question" as const,
          reviewStatus: "rejected" as const,
          warnings: [...question.warnings, ...cleaned.warnings],
        };
      }

      const choiceById = new Map(question.versions.quizReady.choices.map((choice) => [choice.id, choice]));
      const seenChoiceTexts = new Set<string>();
      const choices = cleaned.choices
        .filter((choice) => choice.keep)
        .filter((choice) => {
          const text = cleanChoiceText(choice.text, choice.label);
          const normalized = normalizeChoiceForDedupe(text);
          if (!normalized || isHeaderOrComment(text) || isAnswerLine(text) || isCategoryChoice(text)) {
            return false;
          }
          if (seenChoiceTexts.has(normalized)) {
            return false;
          }
          seenChoiceTexts.add(normalized);
          return true;
        })
        .map((choice, index) => ({
          ...(choiceById.get(choice.id) ?? {
            id: choice.id,
            label: choice.label,
            orderIndex: index,
            boundingBox: null,
          }),
          label: choice.label,
          text: cleanChoiceText(choice.text, choice.label),
          orderIndex: index,
        }));
      const correctChoiceStillExists =
        question.answer.correctChoiceId &&
        choices.some((choice) => choice.id === question.answer.correctChoiceId);

      const stem = preserveFullStem(question.versions.quizReady.stem, cleaned.stem);

      return {
        ...question,
        versions: {
          source: question.versions.source,
          normalized: {
            stem,
            choices,
          },
          quizReady: {
            stem,
            choices,
          },
        },
        answer: correctChoiceStillExists
          ? question.answer
          : {
              ...question.answer,
              correctChoiceId: null,
              status: question.answer.status === "explicit" ? "uncertain" : question.answer.status,
            },
        usabilityStatus: cleaned.usabilityStatus,
        reviewStatus: cleaned.reviewStatus,
        warnings: [...question.warnings, ...cleaned.warnings],
      };
    })
    .filter((question) => question.usabilityStatus !== "not_a_question");
}

function preserveFullStem(sourceStem: string, cleanedStem: string) {
  const source = sourceStem.replace(/\s+/g, " ").trim();
  const cleaned = cleanedStem.replace(/\s+/g, " ").trim();

  if (!cleaned) {
    return source;
  }

  if (cleaned.length < source.length * 0.9) {
    return source;
  }

  if (source.includes("?") && !cleaned.includes("?")) {
    return source;
  }

  return cleaned;
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [simpleMode, setSimpleMode] = useState(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [tab, setTab] = useState<Tab>("review");
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [questions, setQuestions] = useState<CanonicalQuestion[]>([]);
  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [quizAnswers, setQuizAnswers] = useState<QuizAnswer>({});
  const [simpleQuizIndex, setSimpleQuizIndex] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [useVision, setUseVision] = useState(false);
  const [useOcr, setUseOcr] = useState(true);
  const [useAiCleanup, setUseAiCleanup] = useState(true);
  const [markdownPages, setMarkdownPages] = useState<MarkdownPage[]>([]);
  const [pageScreenshots, setPageScreenshots] = useState<PageScreenshot[]>([]);
  const [apiJob, setApiJob] = useState<ApiJob | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsageRecord[]>([]);
  const [fullscreenImage, setFullscreenImage] = useState<string | null>(null);
  const [feedbackRating, setFeedbackRating] = useState<FeedbackRating | null>(null);
  const [feedbackIssue, setFeedbackIssue] = useState("");
  const [feedbackNotes, setFeedbackNotes] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [pdfQuestion, setPdfQuestion] = useState("");
  const [pdfAnswer, setPdfAnswer] = useState("");
  const [pdfAsking, setPdfAsking] = useState(false);
  const [pdfError, setPdfError] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const isSimple = params.get("advanced") !== "1";
    setSimpleMode(isSimple);
    if (isSimple) {
      setUseOcr(true);
      setUseAiCleanup(true);
      setUseVision(false);
    }
  }, []);

  const approvedQuestions = useMemo(
    () =>
      questions.filter(
        (question) =>
          question.reviewStatus !== "rejected" &&
          question.versions.quizReady.choices.length >= 2,
      ),
    [questions],
  );

  const score = useMemo(() => {
    const scorable = approvedQuestions.filter((question) =>
      ["explicit", "editor_confirmed"].includes(question.answer.status),
    );
    const correct = scorable.filter(
      (question) =>
        question.answer.correctChoiceId &&
        quizAnswers[question.id] === question.answer.correctChoiceId,
    );

    return { correct: correct.length, total: scorable.length };
  }, [approvedQuestions, quizAnswers]);

  async function processFile(file: File) {
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Drop a PDF file.");
      setPhase("error");
      return;
    }

    setFileName(file.name);
    setQuestions([]);
    setAssets([]);
    setWarnings([]);
    setMarkdownPages([]);
    setPageScreenshots([]);
    setApiJob(null);
    setAiUsage([]);
    setFullscreenImage(null);
    setFeedbackRating(null);
    setFeedbackIssue("");
    setFeedbackNotes("");
    setFeedbackSending(false);
    setFeedbackSent(false);
    setPdfQuestion("");
    setPdfAnswer("");
    setPdfAsking(false);
    setPdfError("");
    setQuizAnswers({});
    setSimpleQuizIndex(0);
    setSubmitted(false);
    setError("");

    try {
      setPhase("rendering");
      setProgress({ current: 0, total: 0, label: "checking file cache" });
      const fingerprint = await fingerprintFile(file);
      const runStartedAt = performance.now();
      const nextQuestions: CanonicalQuestion[] = [];
      const nextAssets: LocalAsset[] = [];
      const nextWarnings: string[] = [];
      const nextMarkdownPages: MarkdownPage[] = [];
      const nextUsage: AiUsageRecord[] = [];
      let currentApiJob: ApiJob | null = null;

      try {
        currentApiJob = await createApiJob(file, fingerprint);
        setApiJob(currentApiJob);

        if (currentApiJob.reused && currentApiJob.status === "completed" && currentApiJob.resultUrl) {
          const cached = await loadSavedJob(currentApiJob.id);
          setQuestions((cached.questions ?? []).map((question) => question));
          setAssets(
            (cached.assets ?? []).map((asset) => ({
              ...asset,
              previewUrl: asset.previewUrl ?? asset.url,
            })),
          );
          setWarnings(cached.warnings ?? []);
          setMarkdownPages(cached.pages ?? []);
          setAiUsage(cached.usage ?? []);
          setPhase("done");
          setTab("review");
          return;
        }
      } catch (apiError) {
        nextWarnings.push(
          `API job tracking unavailable: ${
            apiError instanceof Error ? apiError.message : "failed"
          }`,
        );
        setWarnings([...nextWarnings]);
      }

      setPhase("rendering");
      await renderPdfPages(file, (current, total, label) => {
        setProgress({ current, total, label });
      }, async (page, total) => {
        setPhase("extracting");
        setProgress({
          current: page.pageNumber,
          total,
          label: "extracting page",
        });
        setPageScreenshots((current) => [
          ...current.filter((item) => item.pageNumber !== page.pageNumber),
          {
            pageNumber: page.pageNumber,
            imageDataUrl: page.imageDataUrl,
            width: page.width,
            height: page.height,
          },
        ]);

        try {
          let pageForExtraction = page;
          const hasEnoughNativeText = page.nativeText.replace(/\s+/g, "").length >= 40;

          if (useOcr && !hasEnoughNativeText) {
            setProgress({
              current: page.pageNumber,
              total,
              label: "running local OCR",
            });
            const ocrText = await ocrPage(page.imageDataUrl);
            pageForExtraction = {
              ...page,
              nativeText: ocrText,
            };
            nextMarkdownPages.push({
              pageNumber: page.pageNumber,
              source: ocrText ? "ocr" : "empty",
              text: ocrText,
            });
          } else {
            nextMarkdownPages.push({
              pageNumber: page.pageNumber,
              source: page.nativeText.trim() ? "native" : "empty",
              text: page.nativeText.trim(),
            });
          }

          setMarkdownPages([...nextMarkdownPages]);

          const nativeResult = extractNativeTextPage(pageForExtraction);
          const needsVision = useVision && nativeResult.questions.length === 0 && page.pageNumber <= MAX_VISION_PAGES;
          const result = needsVision ? await extractPage(file.name, pageForExtraction) : nativeResult;
          const visualCandidates = await detectVisualAssets(page);
          const localVisuals = visualCandidates.filter(
            (asset) =>
              !result.assets.some(
                (existing) =>
                  Math.abs(existing.boundingBox.x - asset.boundingBox.x) < 24 &&
                  Math.abs(existing.boundingBox.y - asset.boundingBox.y) < 24,
              ),
          );
          const finalizedVisuals = await finalizeVisualAssets(page, localVisuals, result.questions);
          nextQuestions.push(...finalizedVisuals.questions);
          nextWarnings.push(...result.warnings.map((warning) => `Page ${page.pageNumber}: ${warning}`));

          for (const asset of [...result.assets, ...finalizedVisuals.assets]) {
            const previewUrl = await cropAsset(
              page.imageDataUrl,
              result.page.width,
              result.page.height,
              asset.boundingBox,
            ).catch(() => undefined);

            nextAssets.push({
              ...asset,
              documentPageNumber: page.pageNumber,
              previewUrl:
                "previewUrl" in asset && typeof asset.previewUrl === "string"
                  ? asset.previewUrl
                  : previewUrl,
            });
          }

          setQuestions([...nextQuestions]);
          setAssets([...nextAssets]);
          setWarnings([...nextWarnings]);
        } catch (pageError) {
          nextWarnings.push(
            `Page ${page.pageNumber}: ${
              pageError instanceof Error ? pageError.message : "failed"
            }`,
          );
          setWarnings([...nextWarnings]);
        }
      });

      if (useAiCleanup && nextQuestions.length) {
        setProgress({
          current: progress.total || nextMarkdownPages.length,
          total: progress.total || nextMarkdownPages.length,
          label: "cleaning extracted questions",
        });

        try {
          const cleanup = await cleanupQuestionsWithAi(nextQuestions);
          if (cleanup.usage || cleanup.cost !== undefined || cleanup.model) {
            nextUsage.push({
              provider: "openrouter",
              purpose: "cleanup",
              model: cleanup.model,
              cost: cleanup.cost ?? null,
              usage: cleanup.usage ?? null,
            });
            setAiUsage([...nextUsage]);
          }
          const cleanedQuestions = applyCleanup(nextQuestions, cleanup);
          nextQuestions.splice(0, nextQuestions.length, ...cleanedQuestions);
          setQuestions([...nextQuestions]);
          setWarnings([
            ...nextWarnings,
            `AI cleanup checked ${cleanup.questions.length} question candidates.`,
          ]);
        } catch (cleanupError) {
          const message =
            cleanupError instanceof Error ? cleanupError.message : "AI cleanup failed.";
          nextWarnings.push(`AI cleanup skipped: ${message}`);
          setWarnings([...nextWarnings]);
        }
      }

      if (currentApiJob) {
        try {
          const markdown = buildFullMarkdown(file.name, nextQuestions, nextMarkdownPages);
          const resultJson = buildExportPayload({
            fileName: file.name,
            status: "completed",
            questions: nextQuestions,
            assets: nextAssets,
            warnings: nextWarnings,
            markdownPages: nextMarkdownPages,
            usage: nextUsage,
          });
          const saved = await saveApiResult({
            jobId: currentApiJob.id,
            resultJson,
            markdown,
            assets: nextAssets,
            usage: nextUsage,
            processingMs: Math.round(performance.now() - runStartedAt),
          });
          setApiJob({ ...currentApiJob, resultUrl: saved.resultUrl });
        } catch (apiError) {
          nextWarnings.push(
            `API result save failed: ${
              apiError instanceof Error ? apiError.message : "failed"
            }`,
          );
          setWarnings([...nextWarnings]);
        }
      }

      setPhase("done");
      setTab("review");
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError.message : "Processing failed.");
      setPhase("error");
    }
  }

  async function submitFeedback(rating: FeedbackRating) {
    if (!apiJob?.id || feedbackSending) {
      return;
    }

    setFeedbackRating(rating);
    setFeedbackSending(true);

    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(apiJob.id)}/feedback`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating,
          issue: rating === "dislike" ? (feedbackIssue.trim() || null) : null,
          notes: feedbackNotes.trim() || null,
          qualityScore: rating === "like" ? 5 : 1,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(payload?.message ?? payload?.error ?? "Could not save feedback.");
      }

      setFeedbackSent(true);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Could not save feedback.");
    } finally {
      setFeedbackSending(false);
    }
  }

  async function askPdf() {
    const question = pdfQuestion.trim();
    if (!question || pdfAsking) {
      return;
    }

    setPdfAsking(true);
    setPdfError("");
    setPdfAnswer("");

    try {
      const response = await fetch("/api/transform", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "qa",
          question,
          text: buildFullMarkdown(fileName, questions, markdownPages),
          instructions: "Answer directly from the document. Keep it short. Mention page numbers when available.",
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
        throw new Error(payload?.message ?? payload?.error ?? "Could not ask the PDF.");
      }

      const payload = (await response.json()) as { output?: { markdown?: string }; markdown?: string };
      setPdfAnswer(payload.output?.markdown ?? payload.markdown ?? "No answer returned.");
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : "Could not ask the PDF.");
    } finally {
      setPdfAsking(false);
    }
  }

  function setReviewStatus(
    questionId: string,
    reviewStatus: CanonicalQuestion["reviewStatus"],
  ) {
    setQuestions((current) =>
      current.map((question) =>
        question.id === questionId ? { ...question, reviewStatus } : question,
      ),
    );
  }

  function setStem(questionId: string, stem: string) {
    setQuestions((current) =>
      current.map((question) =>
        question.id === questionId
          ? {
              ...question,
              reviewStatus: "edited",
              versions: {
                ...question.versions,
                quizReady: { ...question.versions.quizReady, stem },
              },
            }
          : question,
      ),
    );
  }

  function exportJson() {
    const payload = buildExportPayload({
      fileName,
      status: phase === "done" ? "completed" : phase,
      questions,
      assets,
      warnings,
      markdownPages,
      usage: aiUsage,
    });
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${fileName || "filedrop"}-extraction.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function resetRun() {
    setPhase("idle");
    setQuestions([]);
    setAssets([]);
    setWarnings([]);
    setMarkdownPages([]);
    setPageScreenshots([]);
    setApiJob(null);
    setAiUsage([]);
    setFullscreenImage(null);
    setFeedbackRating(null);
    setFeedbackIssue("");
    setFeedbackNotes("");
    setFeedbackSending(false);
    setFeedbackSent(false);
    setPdfQuestion("");
    setPdfAnswer("");
    setPdfAsking(false);
    setPdfError("");
    setProgress({ current: 0, total: 0, label: "" });
    setError("");
    setFileName("");
    setQuizAnswers({});
    setSimpleQuizIndex(0);
    setSubmitted(false);
  }

  const isWorking = phase === "rendering" || phase === "extracting";

  if (simpleMode) {
    const progressPercent = progress.total
      ? Math.round((progress.current / progress.total) * 100)
      : 0;
    const currentQuestion =
      approvedQuestions[Math.min(simpleQuizIndex, Math.max(0, approvedQuestions.length - 1))];
    const allCurrentQuestionAssets = currentQuestion
      ? assets.filter(
          (asset) =>
            currentQuestion.assets.includes(asset.id) || asset.questionId === currentQuestion.id,
        )
      : [];
    const currentQuestionAssets = currentQuestion
      ? allCurrentQuestionAssets.filter((asset) => shouldShowAssetWithQuestion(currentQuestion, asset))
      : [];
    const sourcePageScreenshot = currentQuestion
      ? pageScreenshots.find((page) => page.pageNumber === currentQuestion.source.pageNumbers[0])
      : null;
    const selectedChoiceId = currentQuestion ? quizAnswers[currentQuestion.id] : null;
    const answerKnown =
      currentQuestion?.answer.status === "explicit" ||
      currentQuestion?.answer.status === "editor_confirmed";
    const selectedIsCorrect =
      Boolean(selectedChoiceId) && selectedChoiceId === currentQuestion?.answer.correctChoiceId;
    const answerText = currentQuestion ? answerDisplayText(currentQuestion) : null;

    return (
      <main className="min-h-screen bg-white text-[#0F172A]">
        <div
          className={`mx-auto flex min-h-screen w-full px-4 py-8 ${
            phase === "done"
              ? "max-w-none items-start justify-stretch p-0 sm:p-4"
              : "max-w-3xl items-center justify-center"
          }`}
        >
          <section
            className={`w-full bg-white ${
              phase === "done" ? "rounded-none p-0 sm:rounded-[24px] sm:p-4" : "rounded-[24px] p-6 sm:p-8"
            }`}
          >
            {phase !== "done" ? (
              <div className="mb-7 flex items-center justify-between">
                <h1 className="text-[34px] font-black leading-none tracking-normal sm:text-[38px]">
                  Add a file
                </h1>
                <button
                  type="button"
                  onClick={resetRun}
                  className="grid h-10 w-10 place-items-center rounded-full text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
                  aria-label="Clear"
                >
                  <X className="h-7 w-7" strokeWidth={2.4} />
                </button>
              </div>
            ) : null}

            <input
              ref={inputRef}
              hidden
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void processFile(file);
              }}
            />

            {phase !== "done" ? (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files[0];
                  if (file) void processFile(file);
                }}
                disabled={isWorking}
                className="flex min-h-[245px] w-full flex-col items-center justify-center gap-5 rounded-[22px] border-2 border-dashed border-zinc-200 bg-white px-6 py-10 text-center text-zinc-500 transition hover:border-zinc-300 hover:bg-zinc-50 disabled:cursor-wait disabled:opacity-80"
              >
                {isWorking ? (
                  <Loader2 className="h-12 w-12 animate-spin" strokeWidth={2.3} />
                ) : (
                  <FileUp className="h-12 w-12" strokeWidth={2.3} />
                )}
                <span className="text-[22px] font-extrabold">
                  {fileName || "Drop any file here or tap to browse"}
                </span>
              </button>
            ) : null}

            {phase !== "done" ? (
              <input
                className="mt-6 w-full rounded-[20px] border-2 border-zinc-200 px-5 py-5 text-[22px] font-extrabold text-zinc-700 outline-none placeholder:text-zinc-400 focus:border-sky-400"
                value={fileName.replace(/\.[^.]+$/, "")}
                onChange={(event) => setFileName(event.target.value)}
                placeholder="File name (e.g. March Combined)"
                aria-label="File name"
              />
            ) : null}

            {phase !== "done" && (progress.total || isWorking) ? (
              <div className="mt-5">
                <div className="h-3 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full rounded-full bg-[#58CC02] transition-all"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <p className="mt-3 text-center text-sm font-extrabold text-zinc-500">
                  {progress.total ? `Processing page ${progress.current} of ${progress.total}` : "Preparing file"}
                </p>
              </div>
            ) : null}

            {phase !== "done" && questions.length ? (
              <section className="mt-6 rounded-[22px] border border-zinc-200 bg-zinc-50 p-4 sm:p-5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-black text-zinc-900">First results</p>
                  <p className="text-xs font-bold text-zinc-500">
                    {questions.length} question{questions.length === 1 ? "" : "s"} extracted so far
                  </p>
                </div>
                <div className="mt-4 grid gap-3">
                  {questions.slice(0, 3).map((question, index) => (
                    <article key={question.id} className="rounded-2xl border border-zinc-200 bg-white p-4">
                      <p className="text-xs font-black uppercase tracking-wide text-sky-600">
                        Page {question.source.pageNumbers.join(", ")}
                      </p>
                      <p className="mt-2 text-sm font-extrabold leading-6 text-zinc-950">
                        {question.versions.quizReady.stem}
                      </p>
                      <p className="mt-2 text-xs font-medium text-zinc-500">
                        {question.versions.quizReady.choices.length} choices
                        {index === 2 ? "" : ""}
                      </p>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {error ? (
              <p className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
                {error}
              </p>
            ) : null}

            {phase === "done" ? (
              <div className="min-h-screen rounded-none bg-emerald-50 p-4 sm:min-h-0 sm:rounded-[22px] sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-black uppercase tracking-wide text-emerald-700">
                      Quiz ready
                    </p>
                    <p className="mt-1 text-2xl font-black text-emerald-950">
                      {approvedQuestions.length} question{approvedQuestions.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={resetRun}
                    className="grid h-11 w-11 place-items-center rounded-full bg-white text-zinc-500 transition hover:text-zinc-950"
                    aria-label="Close result"
                  >
                    <X className="h-6 w-6" strokeWidth={2.4} />
                  </button>
                </div>

                {currentQuestion ? (
                  <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(340px,0.7fr)]">
                    <section className="rounded-[20px] border-2 border-emerald-100 bg-white p-5 sm:p-7">
                    <div className="mb-4 flex items-center justify-between gap-3">
                      <span className="rounded-full bg-[#EAF6FF] px-3 py-1 text-sm font-black text-[#1899D6]">
                        Question {simpleQuizIndex + 1} of {approvedQuestions.length}
                      </span>
                      {selectedChoiceId && answerKnown ? (
                        <span
                          className={`rounded-full px-3 py-1 text-sm font-black ${
                            selectedIsCorrect
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-rose-100 text-rose-800"
                          }`}
                        >
                          {selectedIsCorrect ? "Correct" : "Review"}
                        </span>
                      ) : null}
                    </div>

                    <p className="text-lg font-black leading-8 text-zinc-950">
                      {currentQuestion.versions.quizReady.stem}
                    </p>

                    {currentQuestionAssets.length ? (
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {currentQuestionAssets.map((asset) =>
                          asset.previewUrl ? (
                            <button
                              key={asset.id}
                              type="button"
                              onClick={() => setFullscreenImage(asset.previewUrl ?? null)}
                              className="rounded-2xl border-2 border-zinc-100 bg-white p-2"
                            >
                              <img
                                src={asset.previewUrl}
                                alt={`Question image page ${asset.documentPageNumber}`}
                                className="max-h-[55vh] w-full object-contain"
                              />
                            </button>
                          ) : null,
                        )}
                      </div>
                    ) : null}

                    <div className="mt-5 grid gap-3">
                      {currentQuestion.versions.quizReady.choices.map((choice) => {
                        const isSelected = selectedChoiceId === choice.id;
                        const isCorrect = answerKnown && currentQuestion.answer.correctChoiceId === choice.id;
                        const showCorrect = Boolean(selectedChoiceId) && isCorrect;
                        const showWrong = Boolean(selectedChoiceId) && isSelected && !isCorrect;

                        return (
                          <button
                            key={choice.id}
                            type="button"
                            onClick={() =>
                              setQuizAnswers((current) => ({
                                ...current,
                                [currentQuestion.id]: choice.id,
                              }))
                            }
                            className={`flex items-start gap-3 rounded-2xl border-2 px-4 py-4 text-left text-base font-extrabold transition ${
                              showCorrect
                                ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                                : showWrong
                                  ? "border-rose-300 bg-rose-50 text-rose-900"
                                  : isSelected
                                    ? "border-[#1CB0F6] bg-[#EAF6FF] text-zinc-950"
                                    : "border-zinc-200 bg-white text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50"
                            }`}
                          >
                            <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-zinc-100 text-sm">
                              {choice.label ?? choice.orderIndex + 1}
                            </span>
                            <span>{choice.text}</span>
                          </button>
                        );
                      })}
                    </div>

                    {selectedChoiceId && answerKnown && !selectedIsCorrect ? (
                      null
                    ) : null}

                    {selectedChoiceId ? (
                      <div className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-950">
                        {answerKnown && answerText ? (
                          <p>Correct answer: {answerText}</p>
                        ) : (
                          <p>Answer key was not clear in the source.</p>
                        )}
                        {answerKnown ? (
                          <p className="mt-1 text-emerald-800">Explanation: answer key found in the source file.</p>
                        ) : null}
                        {sourcePageScreenshot ? (
                          <details className="mt-3">
                            <summary className="cursor-pointer text-emerald-800">
                              Source page p{sourcePageScreenshot.pageNumber}
                            </summary>
                            <button
                              type="button"
                              onClick={() => setFullscreenImage(sourcePageScreenshot.imageDataUrl)}
                              className="mt-3 w-full rounded-2xl border-2 border-emerald-100 bg-white p-2"
                            >
                              <img
                                src={sourcePageScreenshot.imageDataUrl}
                                alt={`Source page ${sourcePageScreenshot.pageNumber}`}
                                className="max-h-[70vh] w-full object-contain"
                              />
                            </button>
                          </details>
                        ) : null}
                      </div>
                    ) : null}

                    {apiJob?.id ? (
                      <div className="mt-4 rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
                        <p className="text-sm font-bold text-zinc-900">Was this result useful?</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => setFeedbackRating("like")}
                            disabled={feedbackSending}
                            aria-label="Like result"
                            className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-bold ${
                              feedbackRating === "like"
                                ? "bg-emerald-600 text-white"
                                : "bg-white text-zinc-800 border border-zinc-300"
                            }`}
                          >
                            <ThumbsUp className="h-4 w-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setFeedbackRating("dislike")}
                            disabled={feedbackSending}
                            aria-label="Dislike result"
                            className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-bold ${
                              feedbackRating === "dislike"
                                ? "bg-rose-600 text-white"
                                : "bg-white text-zinc-800 border border-zinc-300"
                            }`}
                          >
                            <ThumbsDown className="h-4 w-4" />
                          </button>
                        </div>
                        {feedbackRating === "dislike" ? (
                          <div className="mt-4 grid gap-3">
                            <select
                              value={feedbackIssue}
                              onChange={(event) => setFeedbackIssue(event.target.value)}
                              className="rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm"
                            >
                              <option value="">What was wrong?</option>
                              <option value="mixed_questions">Mixed questions together</option>
                              <option value="wrong_choices">Wrong or duplicate choices</option>
                              <option value="missing_answer">Missing answer key</option>
                              <option value="bad_explanation">Bad explanation</option>
                              <option value="too_slow">Too slow</option>
                              <option value="other">Other</option>
                            </select>
                            <textarea
                              value={feedbackNotes}
                              onChange={(event) => setFeedbackNotes(event.target.value)}
                              rows={3}
                              maxLength={2000}
                              placeholder="Short note"
                              className="rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm"
                            />
                          </div>
                        ) : (
                          <textarea
                            value={feedbackNotes}
                            onChange={(event) => setFeedbackNotes(event.target.value)}
                            rows={2}
                            maxLength={2000}
                            placeholder="Optional note"
                            className="mt-4 w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => void submitFeedback(feedbackRating ?? "like")}
                          disabled={!feedbackRating || feedbackSending}
                          className="mt-3 rounded-full bg-zinc-950 px-4 py-2 text-sm font-bold text-white disabled:bg-zinc-300"
                        >
                          {feedbackSending ? "Sending..." : "Send feedback"}
                        </button>
                        {feedbackSent ? (
                          <p className="mt-3 text-sm font-bold text-emerald-700">Feedback saved.</p>
                        ) : null}
                      </div>
                    ) : null}

                    <div className="mt-5 flex gap-3">
                      <button
                        type="button"
                        onClick={() => setSimpleQuizIndex((index) => Math.max(0, index - 1))}
                        disabled={simpleQuizIndex === 0}
                        className="flex-1 rounded-2xl border-2 border-zinc-200 bg-white px-4 py-3 text-sm font-black text-zinc-700 disabled:opacity-40"
                      >
                        Back
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSimpleQuizIndex((index) =>
                            Math.min(approvedQuestions.length - 1, index + 1),
                          )
                        }
                        disabled={simpleQuizIndex >= approvedQuestions.length - 1}
                        className="flex-1 rounded-2xl bg-[#1CB0F6] px-4 py-3 text-sm font-black text-white shadow-[0_5px_0_#1899D6] disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-none"
                      >
                        Next
                      </button>
                    </div>
                  </section>

                    <aside className="rounded-[20px] border-2 border-zinc-200 bg-white p-5 sm:p-7">
                      <p className="text-sm font-black uppercase tracking-wide text-zinc-500">
                        Chat with PDF
                      </p>
                      <p className="mt-2 text-sm leading-6 text-zinc-600">
                        Ask against the extracted Markdown. This does not rerun the parser.
                      </p>
                      <textarea
                        value={pdfQuestion}
                        onChange={(event) => setPdfQuestion(event.target.value)}
                        rows={5}
                        placeholder="Ask a question about the file"
                        className="mt-4 w-full rounded-2xl border-2 border-zinc-200 px-4 py-3 text-sm outline-none focus:border-sky-400"
                      />
                      <button
                        type="button"
                        onClick={() => void askPdf()}
                        disabled={pdfAsking || !pdfQuestion.trim()}
                        className="mt-3 inline-flex items-center justify-center rounded-full bg-zinc-950 px-4 py-2 text-sm font-bold text-white disabled:bg-zinc-300"
                      >
                        {pdfAsking ? "Asking..." : "Ask"}
                      </button>
                      {pdfError ? <p className="mt-3 text-sm font-medium text-rose-700">{pdfError}</p> : null}
                      {pdfAnswer ? (
                        <pre className="mt-4 whitespace-pre-wrap rounded-2xl bg-zinc-50 p-4 text-sm leading-6 text-zinc-800">
                          {pdfAnswer}
                        </pre>
                      ) : null}
                    </aside>
                  </div>
                ) : (
                  <p className="mt-4 rounded-2xl bg-white px-4 py-4 text-center text-sm font-bold text-zinc-600">
                    No quiz questions were found. Try another file.
                  </p>
                )}
              </div>
            ) : null}

            {phase !== "done" ? (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={isWorking}
                className="mt-6 flex w-full items-center justify-center gap-2 rounded-[22px] bg-[#58CC02] px-5 py-5 text-[20px] font-black text-white shadow-[0_6px_0_#46A302] transition active:translate-y-1 active:shadow-none disabled:bg-zinc-200 disabled:text-zinc-400 disabled:shadow-[0_6px_0_#cfcfcf]"
              >
                {isWorking ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    Processing
                  </>
                ) : (
                  <>
                    <FileUp className="h-5 w-5" />
                    Choose file
                  </>
                )}
              </button>
            ) : null}
          </section>
        </div>
        {fullscreenImage ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-3"
            role="dialog"
            aria-modal="true"
          >
            <button
              type="button"
              onClick={() => setFullscreenImage(null)}
              className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white text-zinc-800"
              aria-label="Close image"
            >
              <X className="h-6 w-6" strokeWidth={2.4} />
            </button>
            <img
              src={fullscreenImage}
              alt="Full screen source"
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : null}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f7f6f2] text-zinc-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <section className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_320px]">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const file = event.dataTransfer.files[0];
              if (file) void processFile(file);
            }}
            className="flex min-h-[260px] flex-col items-center justify-center gap-5 rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-center shadow-sm transition hover:border-zinc-500 hover:bg-zinc-50"
          >
            <input
              ref={inputRef}
              hidden
              type="file"
              accept="application/pdf,.pdf"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void processFile(file);
              }}
            />
            <span className="flex h-14 w-14 items-center justify-center rounded-md bg-zinc-950 text-white">
              {phase === "rendering" || phase === "extracting" ? (
                <Loader2 className="h-7 w-7 animate-spin" />
              ) : (
                <FileUp className="h-7 w-7" />
              )}
            </span>
            <div>
              <h1 className="text-3xl font-semibold tracking-normal">fileDrop</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-600">
                Drop a PDF. Text-based MCQs extract locally with no OpenRouter
                calls. Vision is blocked unless you deliberately re-enable it.
              </p>
            </div>
            <span className="rounded-md bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-600">
              Free text mode
            </span>
          </button>

          <aside className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">Run</p>
              <button
                type="button"
                onClick={() => {
                  setPhase("idle");
                  setQuestions([]);
                  setAssets([]);
                  setWarnings([]);
                  setMarkdownPages([]);
                  setApiJob(null);
                  setAiUsage([]);
                  setProgress({ current: 0, total: 0, label: "" });
                  setError("");
                }}
                className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-200 text-zinc-600 hover:bg-zinc-50"
                aria-label="Reset"
                title="Reset"
              >
                <RotateCcw className="h-4 w-4" />
              </button>
            </div>
            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="rounded-md bg-zinc-50 p-3">
                <dt className="text-zinc-500">Status</dt>
                <dd className="mt-1 font-medium capitalize">{phase}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-3">
                <dt className="text-zinc-500">Pages</dt>
                <dd className="mt-1 font-medium">
                  {progress.total ? `${progress.current}/${progress.total}` : "0"}
                </dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-3">
                <dt className="text-zinc-500">Questions</dt>
                <dd className="mt-1 font-medium">{questions.length}</dd>
              </div>
              <div className="rounded-md bg-zinc-50 p-3">
                <dt className="text-zinc-500">Assets</dt>
                <dd className="mt-1 font-medium">{assets.length}</dd>
              </div>
            </dl>
            <label className="mt-4 flex items-start gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
              <input
                type="checkbox"
                checked={useOcr}
                onChange={(event) => setUseOcr(event.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="block font-medium text-zinc-800">
                  Local OCR for scanned pages
                </span>
                <span className="mt-1 block text-xs leading-5 text-zinc-500">
                  Runs in this browser with Tesseract. No OpenRouter call. Slower
                  on image-only pages.
                </span>
              </span>
            </label>
            <label className="mt-4 flex items-start gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
              <input
                type="checkbox"
                checked={useAiCleanup}
                onChange={(event) => setUseAiCleanup(event.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="flex items-center gap-2 font-medium text-zinc-800">
                  <Filter className="h-4 w-4" />
                  AI cleanup
                </span>
                <span className="mt-1 block text-xs leading-5 text-zinc-500">
                  Text only, capped at 20 candidates. Removes cover pages and
                  unrelated choices. No page images are sent.
                </span>
              </span>
            </label>
            <label className="mt-4 flex items-start gap-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm">
              <input
                type="checkbox"
                checked={useVision}
                onChange={(event) => setUseVision(event.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="block font-medium text-zinc-800">
                  Vision fallback
                </span>
                <span className="mt-1 block text-xs leading-5 text-zinc-500">
                  Server kill switch is off. Enable Cloudflare
                  `ENABLE_VISION_EXTRACTION=true` only after setting an
                  OpenRouter budget.
                </span>
              </span>
            </label>
            {progress.label ? (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-zinc-100">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{
                      width: progress.total
                        ? `${Math.round((progress.current / progress.total) * 100)}%`
                        : "0%",
                    }}
                  />
                </div>
                <p className="mt-2 text-xs text-zinc-500">{progress.label}</p>
              </div>
            ) : null}
            {error ? <p className="mt-4 text-sm text-rose-700">{error}</p> : null}
            {apiJob ? (
              <div className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-900">
                <p className="font-medium">API job</p>
                <p className="mt-1 font-mono">{apiJob.id}</p>
                <a
                  href={apiJob.resultUrl}
                  className="mt-2 inline-block font-medium underline underline-offset-2"
                  target="_blank"
                  rel="noreferrer"
                >
                  Result JSON
                </a>
              </div>
            ) : null}
            {aiUsage.length ? (
              <div className="mt-3 rounded-md border border-zinc-200 bg-white p-3 text-xs text-zinc-600">
                <p className="font-medium text-zinc-800">OpenRouter usage</p>
                {aiUsage.map((usage, index) => (
                  <p key={`${usage.purpose}-${index}`} className="mt-1">
                    {usage.purpose}: {usage.cost == null ? "cost not reported" : `$${usage.cost.toFixed(6)}`}
                  </p>
                ))}
              </div>
            ) : null}
          </aside>
        </section>

        <nav className="flex flex-wrap gap-2">
          {(["review", "markdown", "assets", "quiz", "json"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`rounded-md px-3 py-2 text-sm font-medium capitalize ring-1 ${
                tab === item
                  ? "bg-zinc-950 text-white ring-zinc-950"
                  : "bg-white text-zinc-600 ring-zinc-200 hover:bg-zinc-50"
              }`}
            >
              {item}
            </button>
          ))}
          <button
            type="button"
            onClick={exportJson}
            disabled={!questions.length && !assets.length}
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-white px-3 py-2 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            Export
          </button>
        </nav>

        {warnings.length ? (
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-medium">Warnings</p>
            <ul className="mt-2 space-y-1">
              {warnings.slice(0, 6).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {tab === "review" ? (
          <section className="grid gap-3">
            {questions.length ? (
              questions.map((question, index) => {
                const questionAssets = assets.filter(
                  (asset) =>
                    question.assets.includes(asset.id) || asset.questionId === question.id,
                );

                return (
                  <article
                    key={question.id}
                    className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">Q{index + 1}</span>
                      <span
                        className={`rounded-md px-2 py-1 text-xs font-medium ring-1 ${originTone(
                          question.origin,
                        )}`}
                      >
                        {question.origin}
                      </span>
                      <span
                        className={`rounded-md px-2 py-1 text-xs font-medium ring-1 ${statusTone(
                          question.usabilityStatus,
                        )}`}
                      >
                        {question.usabilityStatus.replaceAll("_", " ")}
                      </span>
                      <span className="rounded-md bg-zinc-100 px-2 py-1 text-xs font-medium text-zinc-600">
                        p{question.source.pageNumbers.join(", ")}
                      </span>
                    </div>

                    <textarea
                      value={question.versions.quizReady.stem}
                      onChange={(event) => setStem(question.id, event.target.value)}
                      className="mt-4 min-h-24 w-full resize-y rounded-md border border-zinc-200 bg-zinc-50 p-3 text-sm leading-6 outline-none focus:border-zinc-500"
                    />

                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {question.versions.quizReady.choices.map((choice) => (
                        <div
                          key={choice.id}
                          className="rounded-md border border-zinc-200 bg-white p-3 text-sm"
                        >
                          <span className="font-semibold text-zinc-500">
                            {choice.label ?? choice.orderIndex + 1}
                          </span>{" "}
                          {choice.text}
                        </div>
                      ))}
                    </div>

                    {questionAssets.length ? (
                      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        {questionAssets.map((asset) =>
                          asset.previewUrl ? (
                            <img
                              key={asset.id}
                              src={asset.previewUrl}
                              alt={`${asset.role} page ${asset.pageNumber}`}
                              className="max-h-56 w-full rounded-md border border-zinc-200 object-contain"
                            />
                          ) : null,
                        )}
                      </div>
                    ) : null}

                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setReviewStatus(question.id, "approved")}
                        className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700"
                      >
                        <Check className="h-4 w-4" />
                        Approve
                      </button>
                      <button
                        type="button"
                        onClick={() => setReviewStatus(question.id, "rejected")}
                        className="inline-flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
                      >
                        <X className="h-4 w-4" />
                        Reject
                      </button>
                      <span className="text-xs text-zinc-500">
                        Answer: {question.answer.sourceChoiceLabel ?? question.answer.status}
                      </span>
                    </div>
                  </article>
                );
              })
            ) : (
              <EmptyState label="No extracted questions yet." />
            )}
          </section>
        ) : null}

        {tab === "markdown" ? (
          <section className="grid gap-4">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  const markdown = buildFullMarkdown(fileName, questions, markdownPages);
                  const url = URL.createObjectURL(
                    new Blob([markdown], { type: "text/markdown" }),
                  );
                  const anchor = document.createElement("a");
                  anchor.href = url;
                  anchor.download = `${fileName || "filedrop"}-extraction.md`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                }}
                disabled={!questions.length && !markdownPages.length}
                className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FileText className="h-4 w-4" />
                Download Markdown
              </button>
            </div>
            <pre className="max-h-[720px] overflow-auto rounded-lg border border-zinc-200 bg-white p-4 text-sm leading-6 text-zinc-800 shadow-sm whitespace-pre-wrap">
              {buildFullMarkdown(fileName, questions, markdownPages)}
            </pre>
          </section>
        ) : null}

        {tab === "assets" ? (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {assets.length ? (
              assets.map((asset) => (
                <article
                  key={asset.id}
                  className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm"
                >
                  {asset.previewUrl ? (
                    <img
                      src={asset.previewUrl}
                      alt={`${asset.role} page ${asset.documentPageNumber}`}
                      className="h-56 w-full rounded-md border border-zinc-200 object-contain"
                    />
                  ) : (
                    <div className="flex h-56 items-center justify-center rounded-md bg-zinc-100 text-sm text-zinc-500">
                      No crop preview
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <span className="rounded-md bg-zinc-100 px-2 py-1">
                      p{asset.documentPageNumber}
                    </span>
                    <span className="rounded-md bg-sky-50 px-2 py-1 text-sky-700">
                      {asset.role.replaceAll("_", " ")}
                    </span>
                    <span className="rounded-md bg-zinc-100 px-2 py-1">
                      {Math.round(asset.confidence * 100)}%
                    </span>
                  </div>
                  {asset.normalizedTranscription ? (
                    <p className="mt-3 text-sm leading-6 text-zinc-700">
                      {asset.normalizedTranscription}
                    </p>
                  ) : null}
                </article>
              ))
            ) : (
              <EmptyState label="No image regions extracted yet." />
            )}
          </section>
        ) : null}

        {tab === "quiz" ? (
          <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Quiz</p>
                <p className="mt-1 text-sm text-zinc-500">
                  {approvedQuestions.length} usable questions
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSubmitted(true)}
                disabled={!approvedQuestions.length}
                className="inline-flex items-center gap-2 rounded-md bg-zinc-950 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Sparkles className="h-4 w-4" />
                Score
              </button>
            </div>

            {submitted ? (
              <p className="mt-4 rounded-md bg-emerald-50 p-3 text-sm font-medium text-emerald-800">
                Score {score.correct}/{score.total}. Missing or uncertain answer keys
                are not counted.
              </p>
            ) : null}

            <div className="mt-5 grid gap-5">
              {approvedQuestions.length ? (
                approvedQuestions.map((question, index) => (
                  <fieldset key={question.id} className="grid gap-3">
                    <legend className="text-sm font-semibold">
                      {index + 1}. {question.versions.quizReady.stem}
                    </legend>
                    {question.versions.quizReady.choices.map((choice) => {
                      const isSelected = quizAnswers[question.id] === choice.id;
                      const isCorrect = submitted && question.answer.correctChoiceId === choice.id;

                      return (
                        <label
                          key={choice.id}
                          className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm ${
                            isCorrect
                              ? "border-emerald-300 bg-emerald-50"
                              : isSelected
                                ? "border-zinc-400 bg-zinc-50"
                                : "border-zinc-200 bg-white"
                          }`}
                        >
                          <input
                            type="radio"
                            name={question.id}
                            checked={isSelected}
                            onChange={() =>
                              setQuizAnswers((current) => ({
                                ...current,
                                [question.id]: choice.id,
                              }))
                            }
                            className="mt-1"
                          />
                          <span>
                            <span className="font-medium">{choice.label ?? choice.orderIndex + 1}.</span>{" "}
                            {choice.text}
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))
              ) : (
                <EmptyState label="Approve extracted questions to start a quiz." />
              )}
            </div>
          </section>
        ) : null}

        {tab === "json" ? (
          <pre className="max-h-[720px] overflow-auto rounded-lg border border-zinc-200 bg-zinc-950 p-4 text-xs leading-5 text-zinc-100 shadow-sm">
            {JSON.stringify(
              buildExportPayload({
                fileName,
                status: phase === "done" ? "completed" : phase,
                questions,
                assets,
                warnings,
                markdownPages,
                usage: aiUsage,
              }),
              null,
              2,
            )}
          </pre>
        ) : null}
      </div>
    </main>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex min-h-40 items-center justify-center rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-500 shadow-sm">
      {label}
    </div>
  );
}
