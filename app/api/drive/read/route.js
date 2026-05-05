import { google } from "googleapis";

function getDriveClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: client });
}

const GOOGLE_DOC = "application/vnd.google-apps.document";
const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDE = "application/vnd.google-apps.presentation";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const fileId = searchParams.get("fileId");
    if (!fileId) {
      return Response.json({ error: "fileId is required" }, { status: 400 });
    }

    const drive = getDriveClient();

    const meta = await drive.files.get({
      fileId,
      fields: "id, name, mimeType, size",
      supportsAllDrives: true,
    });
    const { name, mimeType, size } = meta.data;
    console.log(`[/api/drive/read] fileId=${fileId} name="${name}" mimeType=${mimeType}`);

    let content = "";

    if (mimeType === GOOGLE_DOC) {
      const r = await drive.files.export({
        fileId,
        mimeType: "text/plain",
      });
      content = typeof r.data === "string" ? r.data : String(r.data);
    } else if (mimeType === GOOGLE_SHEET) {
      const r = await drive.files.export({
        fileId,
        mimeType: "text/csv",
      });
      content = typeof r.data === "string" ? r.data : String(r.data);
    } else if (mimeType === GOOGLE_SLIDE) {
      const r = await drive.files.export({
        fileId,
        mimeType: "text/plain",
      });
      content = typeof r.data === "string" ? r.data : String(r.data);
    } else if (
      mimeType?.startsWith("text/") ||
      mimeType === "application/json" ||
      mimeType === "application/xml"
    ) {
      const r = await drive.files.get({
        fileId,
        alt: "media",
        supportsAllDrives: true,
      });
      content = typeof r.data === "string" ? r.data : String(r.data);
    } else {
      return Response.json(
        {
          error: `Cannot read mimeType ${mimeType}. Only Google Docs, Sheets, Slides, and text files can be exported as plain text.`,
          name,
          type: mimeType,
        },
        { status: 415 }
      );
    }

    // Cap returned content so a huge doc can't blow up the chat handler's prompt.
    const MAX = 20000;
    const truncated = content.length > MAX;
    if (truncated) content = content.slice(0, MAX);

    return Response.json({
      content,
      name,
      type: mimeType,
      size,
      truncated,
    });
  } catch (error) {
    console.log("[/api/drive/read GET] FAILED:", error.message, "| code:", error.code);
    return Response.json(
      { error: error.message, code: error.code },
      { status: 500 }
    );
  }
}
