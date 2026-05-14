import { google } from "googleapis";
import OpenAI from "openai";
import { Readable } from "stream";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const TIMEZONE = "America/Phoenix";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Return an OAuth client for the requested account. Unknown/missing accounts
// fall back to the primary so legacy callers keep working unchanged.
function getAuth(account) {
  const isSecondary = account && account === process.env.GOOGLE_EMAIL_2;
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    isSecondary
      ? "https://project-xsf5a.vercel.app/api/google/callback"
      : process.env.GOOGLE_REDIRECT_URI
  );
  auth.setCredentials({
    refresh_token: isSecondary
      ? process.env.GOOGLE_REFRESH_TOKEN_2
      : process.env.GOOGLE_REFRESH_TOKEN,
  });
  return auth;
}

function escapeQ(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Walk the Gmail payload tree and return the first attachment with a
// filename + attachmentId. Recurses through nested multipart parts so
// attachments wrapped in multipart/mixed still surface.
function findAttachment(payload) {
  if (!payload) return null;
  for (const part of payload.parts || []) {
    if (part.filename && part.body?.attachmentId) {
      return {
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType || "application/octet-stream",
      };
    }
    const nested = findAttachment(part);
    if (nested) return nested;
  }
  return null;
}

// Build a Gmail query from Brad's free-form description. GPT handles sender
// → domain mapping (T&K → from:tnkroofing), subject keywords, and date →
// after:/before: bounds. Always appends has:attachment.
async function planEmailSearch(emailDescription, history) {
  const histText = (history || [])
    .slice(-6)
    .map((h) => `${h.role}: ${h.content}`)
    .join("\n");
  const todayPhoenix = new Date().toLocaleDateString("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const result = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `Build a Gmail search query that finds ONE specific email with an attachment.
Return JSON: {"query": "Gmail query string"}.

Rules:
- ALWAYS include "has:attachment".
- Company names with known domains: "T&K Roofing" / "TK Roofing" → from:tnkroofing.
- Other companies: lowercase the name with spaces/punctuation stripped, then from:<stub>.
- People: from:FirstName (Gmail matches display names).
- Subject hints: subject:Keyword.
- If a specific date is mentioned, include after:YYYY/MM/DD and before:YYYY/MM/DD bracketing the target by ±1 day. If no year is given, use the current year.

Today's date: ${todayPhoenix}
Recent conversation:
${histText || "(none)"}

Examples:
"May 1 T&K attachment" → {"query": "from:tnkroofing has:attachment after:2026/04/30 before:2026/05/02"}
"Pershing PDF" → {"query": "subject:Pershing has:attachment"}
"Nicholas's recent attachment" → {"query": "from:Nicholas has:attachment"}
"yesterday's T&K bid" → {"query": "from:tnkroofing has:attachment newer_than:2d"}
"WattMonk invoice from last week" → {"query": "from:wattmonk subject:invoice has:attachment newer_than:10d"}`,
      },
      { role: "user", content: emailDescription },
    ],
  });
  const parsed = JSON.parse(result.choices[0].message.content);
  return parsed.query || "has:attachment";
}

// Find a Drive folder by exact name; create one if it doesn't exist. Returns
// { folderId, created }. folderId is null only on creation failure.
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
    fields: "id",
    supportsAllDrives: true,
  });
  const newId = created.data?.id || null;
  console.log("[email-to-drive] folder created:", folderName, "ID:", newId);
  return { folderId: newId, created: !!newId };
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { folderName, history } = body;
    const directEmailId = body.emailId || null;
    const directAttachmentId = body.attachmentId || null;
    const directFilename = body.filename || null;
    const directAccount = body.account || null;
    const emailDescription = body.emailDescription || null;

    console.log("[email-to-drive] inputs:", {
      folderName,
      mode: directEmailId ? "direct" : "search",
      emailDescription,
      directEmailId,
      directAccount,
    });

    if (!folderName) {
      return Response.json(
        { success: false, error: "folderName is required" },
        { status: 400 }
      );
    }
    if (!directEmailId && !emailDescription) {
      return Response.json(
        { success: false, error: "either emailId+attachmentId or emailDescription is required" },
        { status: 400 }
      );
    }

    let auth = null;
    let pickedAccount = null;
    let messageData = null;
    let attachment = null;

    if (directEmailId && directAttachmentId) {
      // Direct mode: caller passes IDs (and ideally `account`) from jessState.
      // Fetch the message from the named account — no Gmail search.
      pickedAccount = directAccount || process.env.GOOGLE_EMAIL;
      auth = getAuth(pickedAccount);
      const msg = await google.gmail({ version: "v1", auth }).users.messages.get({
        userId: "me",
        id: directEmailId,
        format: "full",
      });
      messageData = msg.data;
      attachment = findAttachment(msg.data.payload);
      // If the recursive walk missed it (rare), trust the caller's ID and
      // synthesize the metadata so the download still works.
      if (!attachment) {
        attachment = {
          attachmentId: directAttachmentId,
          filename: directFilename || "attachment",
          mimeType: "application/octet-stream",
        };
      }
      console.log("[email-to-drive] direct mode picked:", directEmailId, attachment.filename, "account:", pickedAccount);
    } else {
      const query = await planEmailSearch(emailDescription, history);
      console.log("[email-to-drive] Gmail query:", query);

      // Search both accounts in parallel; we don't know which inbox owns the
      // email Brad means.
      const account1 = process.env.GOOGLE_EMAIL;
      const account2 = process.env.GOOGLE_EMAIL_2;
      const auth1 = getAuth(account1);
      const auth2 = getAuth(account2);

      const safeList = (a, label) =>
        google
          .gmail({ version: "v1", auth: a })
          .users.messages.list({ userId: "me", q: query, maxResults: 10 })
          .catch((e) => {
            console.log(`[email-to-drive] list failed (${label}):`, e.message);
            return { data: { messages: [] } };
          });

      const [list1, list2] = await Promise.all([
        safeList(auth1, account1),
        safeList(auth2, account2),
      ]);

      const candidates = [
        ...(list1.data.messages || []).map((m) => ({ id: m.id, account: account1, auth: auth1 })),
        ...(list2.data.messages || []).map((m) => ({ id: m.id, account: account2, auth: auth2 })),
      ];
      console.log("[email-to-drive] candidate count:", candidates.length);

      if (candidates.length === 0) {
        return Response.json({
          success: false,
          error: `No emails matched "${emailDescription}" (query: ${query})`,
        });
      }

      // Walk candidates and pick the first message that actually carries an
      // attachment. Gmail's has:attachment filter is reliable but we still
      // re-verify by parsing the payload.
      for (const c of candidates) {
        const g = google.gmail({ version: "v1", auth: c.auth });
        const msg = await g.users.messages.get({
          userId: "me",
          id: c.id,
          format: "full",
        });
        const found = findAttachment(msg.data.payload);
        if (found) {
          messageData = msg.data;
          attachment = found;
          pickedAccount = c.account;
          auth = c.auth;
          break;
        }
      }
      if (!messageData || !attachment) {
        return Response.json({
          success: false,
          error: `Matched ${candidates.length} email(s) but couldn't find an attachment`,
        });
      }
      console.log("[email-to-drive] search picked message:", messageData.id, "attachment:", attachment.filename, "account:", pickedAccount);
    }

    const gmail = google.gmail({ version: "v1", auth });
    const drive = google.drive({ version: "v3", auth });

    const { folderId, created: folderCreated } = await resolveFolderId(drive, folderName);
    console.log("Saving to folder:", folderName, "ID:", folderId);
    if (!folderId) {
      return Response.json(
        { success: false, error: `Could not resolve or create folder "${folderName}"` },
        { status: 500 }
      );
    }

    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId: messageData.id,
      id: attachment.attachmentId,
    });
    if (!att.data?.data) {
      return Response.json({
        success: false,
        error: "Gmail returned no attachment bytes",
      });
    }
    const buffer = Buffer.from(att.data.data, "base64url");
    if (!buffer.length) {
      return Response.json({
        success: false,
        error: "Attachment decoded to 0 bytes",
      });
    }

    const uploaded = await drive.files.create({
      requestBody: {
        name: attachment.filename,
        parents: [folderId],
      },
      media: {
        mimeType: attachment.mimeType,
        body: Readable.from(buffer),
      },
      fields: "id, name, webViewLink",
      supportsAllDrives: true,
    });

    return Response.json({
      success: true,
      filename: uploaded.data.name,
      link: uploaded.data.webViewLink,
      folderName,
      folderCreated,
      account: pickedAccount,
    });
  } catch (error) {
    console.log("[email-to-drive] FAILED:", error.message, "| code:", error.code);
    return Response.json(
      { success: false, error: error.message, code: error.code },
      { status: 500 }
    );
  }
}
