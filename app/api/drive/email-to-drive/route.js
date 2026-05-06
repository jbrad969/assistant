import { google } from "googleapis";
import { Readable } from "stream";

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

// Walk the Gmail message payload tree and find an attachment matching either
// attachmentId (preferred) or filename. Returns { attachmentId, filename, mimeType }.
function findAttachment(payload, wantedId, wantedName) {
  if (!payload) return null;
  const parts = payload.parts || [];
  for (const part of parts) {
    if (part.body?.attachmentId) {
      const matchesId = wantedId && part.body.attachmentId === wantedId;
      const matchesName = wantedName && part.filename === wantedName;
      if (matchesId || matchesName || (!wantedId && !wantedName && part.filename)) {
        return {
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType || "application/octet-stream",
        };
      }
    }
    const nested = findAttachment(part, wantedId, wantedName);
    if (nested) return nested;
  }
  return null;
}

export async function POST(req) {
  try {
    const { emailId, attachmentId, fileName, folderId, folderName } = await req.json();
    console.log("[email-to-drive] inputs:", { emailId, attachmentId, fileName, folderId, folderName });

    if (!emailId) {
      return Response.json({ error: "emailId is required" }, { status: 400 });
    }

    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });
    const drive = google.drive({ version: "v3", auth });

    // Resolve folder: explicit folderId wins; else look up by name; else root.
    let parentId = folderId || null;
    if (!parentId && folderName) {
      const folderRes = await drive.files.list({
        q: `name = '${String(folderName).replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: "files(id, name)",
        pageSize: 1,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
      });
      parentId = folderRes.data.files?.[0]?.id || null;
      console.log("[email-to-drive] folder resolution:", { folderName, resolvedId: parentId });
      if (!parentId) {
        return Response.json(
          { success: false, error: `Folder "${folderName}" not found in Drive` },
          { status: 404 }
        );
      }
    }

    // Fetch the email so we can locate the attachment metadata + filename + mimeType.
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: emailId,
      format: "full",
    });
    const found = findAttachment(msg.data.payload, attachmentId, fileName);
    console.log("[email-to-drive] attachment found:", found);
    if (!found) {
      return Response.json(
        { success: false, error: "No matching attachment found in that email" },
        { status: 404 }
      );
    }

    // Pull the attachment bytes.
    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: emailId,
      id: found.attachmentId,
    });
    if (!att.data?.data) {
      console.log("[email-to-drive] Gmail returned no attachment data for id:", found.attachmentId);
      return Response.json(
        { success: false, error: "Gmail returned no attachment data" },
        { status: 502 }
      );
    }

    // Gmail returns base64url-encoded bytes — Node's Buffer supports that
    // encoding directly (cleaner than the manual -+/_ swap).
    const buffer = Buffer.from(att.data.data, "base64url");
    console.log("[email-to-drive] decoded buffer size:", buffer.length, "bytes; mimeType:", found.mimeType);

    const driveCreate = await drive.files.create({
      requestBody: {
        name: fileName || found.filename || "attachment",
        parents: parentId ? [parentId] : undefined,
      },
      media: {
        mimeType: found.mimeType,
        body: Readable.from(buffer),
      },
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });

    console.log("[email-to-drive] drive.files.create result:", JSON.stringify(driveCreate.data));

    return Response.json({
      success: true,
      fileId: driveCreate.data.id,
      name: driveCreate.data.name,
      link: driveCreate.data.webViewLink,
      sourceEmailId: emailId,
      sourceAttachment: found.filename,
    });
  } catch (error) {
    console.log(
      "[/api/drive/email-to-drive POST] FAILED:",
      error.message,
      "| code:",
      error.code,
      "| stack:",
      error.stack?.split("\n").slice(0, 3).join(" | ")
    );
    return Response.json(
      { success: false, error: error.message, code: error.code },
      { status: 500 }
    );
  }
}
