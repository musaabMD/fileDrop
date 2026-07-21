"use client";

/* eslint-disable @next/next/no-img-element */

import {
  Check,
  Download,
  FileText,
  FileUp,
  Loader2,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";
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

  const paragraphBlocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => block.split(/\n/).filter(Boolean).length >= 3);

  if (paragraphBlocks.length > 1) {
    return paragraphBlocks;
  }

  const lineBlocks = splitRecallLines(text);
  if (lineBlocks.length > 1) {
    return lineBlocks;
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
  if (trailingChoices.length < 2) {
    return false;
  }

  return looksLikeQuestionStartLine(line) || !looksLikeChoiceLine(line);
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
  const choices = choiceMatches.map((match, index) => ({
    id: `${questionId}_c${index + 1}`,
    label: match[1]?.toUpperCase() ?? null,
    text: match[2]?.trim() || "Review choice",
    orderIndex: index,
    boundingBox: null,
  }));
  const answerMatch = block.match(/\b(?:Answer|Ans)\s*[:\-]?\s*([A-H])\b/i);
  const answerLabel = answerMatch?.[1]?.toUpperCase() ?? null;

  return createNativeQuestion({
    page,
    questionIndex,
    stem,
    choices,
    answerLabel,
    answerRawText: answerMatch?.[0] ?? null,
    confidence: answerLabel ? 0.82 : 0.72,
  });
}

function buildRecallStyleQuestion(
  block: string,
  page: PageWork,
  questionIndex: number,
): CanonicalQuestion | null {
  const lines = block
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !isHeaderOrComment(line));

  if (lines.length < 3) {
    return null;
  }

  const questionEnd = lines.findIndex((line) => line.includes("?"));
  let stemLines: string[];
  let choiceLines: string[];

  if (questionEnd >= 0 && lines.length - questionEnd - 1 >= 2) {
    stemLines = lines.slice(0, questionEnd + 1);
    choiceLines = lines.slice(questionEnd + 1);
  } else {
    const trailingChoices = collectTrailingChoices(lines);
    if (trailingChoices.length < 2 || trailingChoices.length >= lines.length) {
      return null;
    }

    stemLines = lines.slice(0, lines.length - trailingChoices.length);
    choiceLines = trailingChoices;
  }

  choiceLines = choiceLines
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => line && !isHeaderOrComment(line))
    .slice(0, 6);

  if (choiceLines.length < 2 || !stemLines.join(" ").trim()) {
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
    stem: stemLines.join(" ").replace(/^(?:Q(?:uestion)?\s*)?\d{1,4}[\).:-]\s*/i, "").trim(),
    choices,
    answerLabel: null,
    answerRawText: null,
    confidence: 0.68,
  });
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
  return line.length <= 90 && wordCount <= 10 && !/^(and|or|but)\b/i.test(line);
}

function looksLikeQuestionLine(line: string) {
  return (
    line.includes("?") ||
    /\b(what|which|best|most likely|diagnosis|management|treatment|next step|initial|confirm|responsible)\b/i.test(line)
  );
}

function looksLikeQuestionStartLine(line: string) {
  return (
    /^(?:\d{1,4}[\).:-]\s*)?(?:a|an|the)?\s*(patient|woman|man|male|female|child|boy|girl|newborn|infant|pregnant|question|pt)\b/i.test(line) ||
    /\b(presents?|came|coming|history|diagnosed|scheduled|asking|what|which|best|most likely)\b/i.test(line)
  );
}

function isHeaderOrComment(line: string) {
  return (
    /^April 15 2026 SMLE Morning Exam$/i.test(line) ||
    /^Tried to remember/i.test(line) ||
    /^The missing questions/i.test(line) ||
    /^Wish you all/i.test(line) ||
    /^Alhomrani:/i.test(line)
  );
}

function createNativeQuestion({
  page,
  questionIndex,
  stem,
  choices,
  answerLabel,
  answerRawText,
  confidence,
}: {
  page: PageWork;
  questionIndex: number;
  stem: string;
  choices: CanonicalQuestion["versions"]["quizReady"]["choices"];
  answerLabel: string | null;
  answerRawText: string | null;
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
      status: answerLabel ? "explicit" : "missing",
      rawAnswerText: answerRawText,
      evidenceIds: [],
      confidence: answerLabel ? 0.7 : 0,
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
    usabilityStatus: answerLabel ? "quiz_ready" : "needs_review",
    confidence: {
      segmentation: confidence,
      stem: confidence,
      choices: confidence,
      answer: answerLabel ? 0.7 : 0,
      imageAssociation: 1,
      duplicateResolution: 1,
      overall: confidence,
    },
    warnings: [],
    reviewStatus: "review_required",
  };
}

export default function Home() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [tab, setTab] = useState<Tab>("review");
  const [fileName, setFileName] = useState("");
  const [progress, setProgress] = useState({ current: 0, total: 0, label: "" });
  const [questions, setQuestions] = useState<CanonicalQuestion[]>([]);
  const [assets, setAssets] = useState<LocalAsset[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [quizAnswers, setQuizAnswers] = useState<QuizAnswer>({});
  const [submitted, setSubmitted] = useState(false);
  const [useVision, setUseVision] = useState(false);
  const [useOcr, setUseOcr] = useState(false);
  const [markdownPages, setMarkdownPages] = useState<MarkdownPage[]>([]);

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
    setQuizAnswers({});
    setSubmitted(false);
    setError("");

    try {
      const nextQuestions: CanonicalQuestion[] = [];
      const nextAssets: LocalAsset[] = [];
      const nextWarnings: string[] = [];
      const nextMarkdownPages: MarkdownPage[] = [];

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

      setPhase("done");
      setTab("review");
    } catch (unknownError) {
      setError(unknownError instanceof Error ? unknownError.message : "Processing failed.");
      setPhase("error");
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
    const payload = {
      schemaVersion: "1.0",
      document: {
        filename: fileName,
        status: phase === "done" ? "completed" : phase,
      },
      statistics: {
        totalQuestions: questions.length,
        quizReady: questions.filter((question) => question.usabilityStatus === "quiz_ready").length,
        needsReview: questions.filter((question) => question.usabilityStatus === "needs_review").length,
        extractedAssets: assets.length,
      },
      questions,
      assets,
      warnings,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${fileName || "filedrop"}-extraction.json`;
    anchor.click();
    URL.revokeObjectURL(url);
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
                  const markdown = [
                    questionsToMarkdown(fileName, questions),
                    "",
                    "---",
                    "",
                    "# Page Text",
                    "",
                    ...markdownPages.map(pageToMarkdown),
                  ].join("\n");
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
              {[
                questionsToMarkdown(fileName, questions),
                "",
                "---",
                "",
                "# Page Text",
                "",
                ...markdownPages.map(pageToMarkdown),
              ].join("\n")}
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
            {JSON.stringify({ fileName, questions, assets, warnings }, null, 2)}
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
