// Standalone file analyzer. POST multipart/form-data with `file` (and optional
// `prompt`) → returns { success, summary }. Single-shot: no history, no chat
// state. Supports images via Claude vision, PDFs via Claude native document
// support, and plain text. DOCX/other types are rejected with a clear error.
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const CLAUDE_MODEL = "claude-sonnet-4-5";

const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

async function fileToBase64(file) {
  const buf = Buffer.from(await file.arrayBuffer());
  return buf.toString("base64");
}

export async function POST(req) {
  try {
    const contentType = req.headers.get("content-type") || "";
    if (!contentType.startsWith("multipart/form-data")) {
      return Response.json(
        { success: false, error: "Expected multipart/form-data" },
        { status: 400 }
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    const prompt = (form.get("prompt") || "").toString().trim();

    if (!file || typeof file === "string") {
      return Response.json({ success: false, error: "No file provided" }, { status: 400 });
    }

    const mime = file.type || "";
    let content;

    if (SUPPORTED_IMAGE_TYPES.has(mime)) {
      content = [
        {
          type: "image",
          source: { type: "base64", media_type: mime, data: await fileToBase64(file) },
        },
        { type: "text", text: prompt || "Describe what you see in this image. Be specific and useful." },
      ];
    } else if (mime === "application/pdf") {
      content = [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: await fileToBase64(file) },
        },
        { type: "text", text: prompt || "Summarize this document. Highlight key points, dates, names, and amounts." },
      ];
    } else if (mime.startsWith("text/") || mime === "application/json") {
      const text = await file.text();
      content = [{ type: "text", text: `${prompt || "Summarize this text file."}\n\n---\n${text}` }];
    } else {
      return Response.json(
        {
          success: false,
          error: `Unsupported file type: ${mime || "unknown"}. Supported: JPG, PNG, GIF, WebP, PDF, and plain text.`,
        },
        { status: 415 }
      );
    }

    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{ role: "user", content }],
    });

    const summary = response.content?.[0]?.text || "";
    return Response.json({ success: true, summary, filename: file.name, mime });
  } catch (error) {
    console.log("analyze error:", error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
