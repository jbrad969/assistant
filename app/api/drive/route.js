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

// Drive's q-syntax escapes single quotes with a backslash. Apostrophes in user
// input ("Brad's report") would otherwise produce invalid queries.
function escapeQ(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

async function findFolderId(drive, folderName) {
  if (!folderName) return null;
  const res = await drive.files.list({
    q: `name = '${escapeQ(folderName)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id, name)",
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });
  return res.data.files?.[0]?.id || null;
}

const TYPE_TO_MIME = {
  folder: FOLDER_MIME,
  pdf: "application/pdf",
  doc: "application/vnd.google-apps.document",
  sheet: "application/vnd.google-apps.spreadsheet",
  slide: "application/vnd.google-apps.presentation",
};

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search");
    const folder = searchParams.get("folder");
    const type = searchParams.get("type");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 100);

    const drive = getDriveClient();

    const clauses = ["trashed = false"];

    if (search) {
      const q = escapeQ(search);
      clauses.push(`(name contains '${q}' or fullText contains '${q}')`);
    }

    if (type && TYPE_TO_MIME[type]) {
      clauses.push(`mimeType = '${TYPE_TO_MIME[type]}'`);
    } else if (type === "file") {
      clauses.push(`mimeType != '${FOLDER_MIME}'`);
    }

    if (folder) {
      const folderId = await findFolderId(drive, folder);
      if (!folderId) {
        return Response.json({
          files: [],
          total: 0,
          warning: `No folder named "${folder}" found.`,
        });
      }
      clauses.push(`'${folderId}' in parents`);
    }

    const q = clauses.join(" and ");
    console.log("[/api/drive GET] q:", q);

    const result = await drive.files.list({
      q,
      pageSize: limit,
      orderBy: "modifiedTime desc",
      fields:
        "files(id, name, mimeType, webViewLink, webContentLink, modifiedTime, size, parents, shared, owners(displayName,emailAddress))",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });

    const files = result.data.files || [];
    console.log("[/api/drive GET] files returned:", files.length);

    return Response.json({ files, total: files.length });
  } catch (error) {
    console.log("[/api/drive GET] FAILED:", error.message, "| code:", error.code);
    return Response.json(
      { error: error.message, code: error.code },
      { status: 500 }
    );
  }
}

export async function POST(req) {
  try {
    const { folderName, parentFolderName } = await req.json();
    if (!folderName) {
      return Response.json({ error: "folderName is required" }, { status: 400 });
    }

    const drive = getDriveClient();
    const requestBody = { name: folderName, mimeType: FOLDER_MIME };

    if (parentFolderName) {
      const parentId = await findFolderId(drive, parentFolderName);
      if (!parentId) {
        return Response.json(
          { success: false, error: `Parent folder "${parentFolderName}" not found` },
          { status: 404 }
        );
      }
      requestBody.parents = [parentId];
    }

    const result = await drive.files.create({
      requestBody,
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });

    return Response.json({
      success: true,
      folderId: result.data.id,
      name: result.data.name,
      link: result.data.webViewLink,
    });
  } catch (error) {
    console.log("[/api/drive POST] FAILED:", error.message);
    return Response.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(req) {
  try {
    const body = await req.json();
    const {
      action,
      fileId,
      targetFolderName,
      shareEmail,
      shareRole,
    } = body;

    if (!action) {
      return Response.json({ error: "action is required" }, { status: 400 });
    }
    if (!fileId && action !== "makePublic") {
      return Response.json({ error: "fileId is required" }, { status: 400 });
    }

    const drive = getDriveClient();

    if (action === "share") {
      if (!shareEmail) {
        return Response.json(
          { error: "shareEmail is required for action=share" },
          { status: 400 }
        );
      }
      const role = shareRole === "writer" || shareRole === "commenter" ? shareRole : "reader";
      await drive.permissions.create({
        fileId,
        requestBody: { type: "user", role, emailAddress: shareEmail },
        sendNotificationEmail: true,
        supportsAllDrives: true,
      });
      const meta = await drive.files.get({
        fileId,
        fields: "webViewLink, name",
        supportsAllDrives: true,
      });
      return Response.json({
        success: true,
        sharedWith: shareEmail,
        role,
        link: meta.data.webViewLink,
        name: meta.data.name,
      });
    }

    if (action === "makePublic") {
      if (!fileId) {
        return Response.json({ error: "fileId is required" }, { status: 400 });
      }
      await drive.permissions.create({
        fileId,
        requestBody: { type: "anyone", role: "reader" },
        supportsAllDrives: true,
      });
      const meta = await drive.files.get({
        fileId,
        fields: "webViewLink, name",
        supportsAllDrives: true,
      });
      return Response.json({
        success: true,
        public: true,
        link: meta.data.webViewLink,
        name: meta.data.name,
      });
    }

    if (action === "move") {
      if (!targetFolderName) {
        return Response.json(
          { error: "targetFolderName is required for action=move" },
          { status: 400 }
        );
      }
      const targetId = await findFolderId(drive, targetFolderName);
      if (!targetId) {
        return Response.json(
          { error: `Target folder "${targetFolderName}" not found` },
          { status: 404 }
        );
      }
      const current = await drive.files.get({
        fileId,
        fields: "parents, name, webViewLink",
        supportsAllDrives: true,
      });
      const removeParents = (current.data.parents || []).join(",");
      const updated = await drive.files.update({
        fileId,
        addParents: targetId,
        removeParents,
        fields: "id, name, parents, webViewLink",
        supportsAllDrives: true,
      });
      return Response.json({
        success: true,
        name: updated.data.name,
        link: updated.data.webViewLink,
        movedTo: targetFolderName,
      });
    }

    if (action === "copy") {
      if (!targetFolderName) {
        return Response.json(
          { error: "targetFolderName is required for action=copy" },
          { status: 400 }
        );
      }
      const targetId = await findFolderId(drive, targetFolderName);
      if (!targetId) {
        return Response.json(
          { error: `Target folder "${targetFolderName}" not found` },
          { status: 404 }
        );
      }
      const copy = await drive.files.copy({
        fileId,
        requestBody: { parents: [targetId] },
        fields: "id, name, webViewLink",
        supportsAllDrives: true,
      });
      return Response.json({
        success: true,
        copyId: copy.data.id,
        name: copy.data.name,
        link: copy.data.webViewLink,
        copiedTo: targetFolderName,
      });
    }

    return Response.json(
      { error: `unknown action: ${action}` },
      { status: 400 }
    );
  } catch (error) {
    console.log("[/api/drive PATCH] FAILED:", error.message, "| code:", error.code);
    return Response.json(
      { success: false, error: error.message, code: error.code },
      { status: 500 }
    );
  }
}

export async function DELETE(req) {
  try {
    const { fileId } = await req.json();
    if (!fileId) {
      return Response.json({ error: "fileId is required" }, { status: 400 });
    }
    const drive = getDriveClient();
    await drive.files.update({
      fileId,
      requestBody: { trashed: true },
      supportsAllDrives: true,
    });
    return Response.json({ success: true, fileId, trashed: true });
  } catch (error) {
    console.log("[/api/drive DELETE] FAILED:", error.message);
    return Response.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
