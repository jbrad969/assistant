import { google } from "googleapis";
import { Readable } from "stream";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function getAuth() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return auth;
}

function escapeQ(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Find the attachment in the Gmail message tree by attachmentId, falling back
// to filename match. Recurses through nested multipart parts.
function findAttachment(payload, attachmentId, filename) {
  if (!payload) return null;
  for (const part of payload.parts || []) {
    if (part.body?.attachmentId) {
      if (part.body.attachmentId === attachmentId) {
        return {
          attachmentId: part.body.attachmentId,
          filename: part.filename || filename || "attachment",
          mimeType: part.mimeType || "application/octet-stream",
        };
      }
      if (filename && part.filename === filename) {
        return {
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
        };
      }
    }
    const nested = findAttachment(part, attachmentId, filename);
    if (nested) return nested;
  }
  return null;
}

async function resolveFolderId(drive, folderName) {
  const lookup = await drive.files.list({
    q: `name = '${escapeQ(folderName)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  const existing = lookup.data.files?.[0];
  if (existing?.id) {
    console.log("[email-to-drive] folder found:", folderName, "ID:", existing.id);
    return { folderId: existing.id, created: false };
  }

  const created = await drive.files.create({
    requestBody: { name: folderName, mimeType: FOLDER_MIME },
    fields: "id, name",
    supportsAllDrives: true,
  });
  const newId = created.data?.id || null;
  console.log("[email-to-drive] folder created:", folderName, "ID:", newId);
  return { folderId: newId, created: !!newId };
}

export async function POST(req) {
  try {
    const { emailId, attachmentId, filename, folderName } = await req.json();
    console.log("[/api/drive/email-to-drive] inputs:", { emailId, attachmentId, filename, folderName });

    if (!emailId || !attachmentId || !folderName) {
      return Response.json(
        { success: false, error: "emailId, attachmentId, and folderName are required" },
        { status: 400 }
      );
    }

    const auth = getAuth();
    const gmail = google.gmail({ version: "v1", auth });
    const drive = google.drive({ version: "v3", auth });

    const { folderId, created: folderCreated } = await resolveFolderId(drive, folderName);
    console.log("Saving to folder:", folderName, "ID:", folderId);

    // Without this guard, Drive treats parents:[undefined] as "no parent" and
    // silently drops the file into root. Refuse to upload — that's the bug.
    if (!folderId) {
      return Response.json(
        { success: false, error: `Could not resolve or create folder "${folderName}"` },
        { status: 500 }
      );
    }

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: emailId,
      format: "full",
    });
    const found = findAttachment(msg.data.payload, attachmentId, filename);
    if (!found) {
      return Response.json(
        { success: false, error: "Attachment not found in that email" },
        { status: 404 }
      );
    }

    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: emailId,
      id: found.attachmentId,
    });
    if (!att.data?.data) {
      return Response.json(
        { success: false, error: "Gmail returned no attachment bytes" },
        { status: 502 }
      );
    }

    const buffer = Buffer.from(att.data.data, "base64url");
    if (!buffer.length) {
      return Response.json(
        { success: false, error: "Attachment decoded to 0 bytes" },
        { status: 502 }
      );
    }

    const uploaded = await drive.files.create({
      requestBody: {
        name: filename || found.filename,
        parents: [folderId],
      },
      media: {
        mimeType: found.mimeType,
        body: Readable.from(buffer),
      },
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });

    return Response.json({
      success: true,
      fileId: uploaded.data.id,
      name: uploaded.data.name,
      link: uploaded.data.webViewLink,
      folderName,
      folderCreated,
    });
  } catch (error) {
    console.log("[/api/drive/email-to-drive] FAILED:", error.message, "| code:", error.code);
    return Response.json(
      { success: false, error: error.message, code: error.code },
      { status: 500 }
    );
  }
}
