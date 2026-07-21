import { NextResponse } from "next/server";
import { z } from "zod";
import { extractPage } from "@/lib/openrouter";

const requestSchema = z.object({
  fileName: z.string().min(1),
  pageNumber: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  nativeText: z.string(),
  imageDataUrl: z.string().startsWith("data:image/"),
});

export async function POST(request: Request) {
  if (process.env.ENABLE_VISION_EXTRACTION !== "true") {
    return NextResponse.json(
      {
        error: "Vision extraction is disabled.",
        message:
          "OpenRouter calls are blocked by ENABLE_VISION_EXTRACTION=false to prevent unexpected cost.",
      },
      { status: 403 },
    );
  }

  const parsed = requestSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid extraction request.", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await extractPage(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown extraction failure.";

    return NextResponse.json(
      {
        error: "Page extraction failed.",
        message,
      },
      { status: message.includes("OPENROUTER_API_KEY") ? 503 : 502 },
    );
  }
}
