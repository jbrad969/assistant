import { google } from "googleapis";

function getGmailClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });

  return client;
}

function decodeBody(payload) {
  if (!payload) return "";

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8");
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return Buffer.from(part.body.data, "base64").toString("utf-8")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      }
    }
  }

  return "";
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const explicitLimit = searchParams.get("limit");
    const all = searchParams.get("all") === "true";
    // Accept repeated &search=... params so callers can pass multiple Gmail
    // queries in one HTTP round trip; we run them in parallel and dedupe.
    const searches = searchParams.getAll("search").filter(Boolean);
    const fullBody = searchParams.get("full") === "true";
    const recent = searchParams.get("recent") === "true";

    // Searches default to 50 per query (Brad wants historical context); plain
    // fetches default to 10. Caller can always override via ?limit=.
    const isSearch = searches.length > 0;
    const defaultLimit = isSearch ? 50 : 10;
    const limit = explicitLimit ? parseInt(explicitLimit) : defaultLimit;

    const auth = getGmailClient();
    const gmail = google.gmail({ version: "v1", auth });

    // No "in:inbox" or "is:unread" wrapping. An empty q searches ALL mail
    // (newest first); search terms run literally so they match read + unread
    // across every folder. Anything else over-restricts results.
    const queries = isSearch ? searches : [""];

    const listResults = await Promise.all(
      queries.map((q) =>
        gmail.users.messages.list({
          userId: "me",
          q,
          maxResults: all ? 50 : limit,
        }).catch((e) => {
          console.log(`[/api/email GET] list failed for q="${q}":`, e.message);
          return { data: { messages: [] } };
        })
      )
    );

    // Dedupe by message id while preserving first-seen order.
    const seenIds = new Set();
    const messages = [];
    for (const r of listResults) {
      for (const m of r.data.messages || []) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          messages.push(m);
        }
      }
    }

    if (messages.length === 0) {
      return Response.json({ emails: [], text: "No emails found.", queries });
    }

    const emails = await Promise.all(
      messages.map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "full",
        });

        const headers = detail.data.payload?.headers || [];
        const headerVal = (name) =>
          headers.find((h) => (h.name || "").toLowerCase() === name.toLowerCase())?.value || "";
        const subject = headerVal("Subject") || "No subject";
        const from = headerVal("From") || "Unknown";
        const to = headerVal("To");
        const date = headerVal("Date");
        const decoded = decodeBody(detail.data.payload);
        const body = fullBody ? decoded.slice(0, 8000) : decoded.slice(0, 500);

        // Parse the From header into a bare address and a display name.
        // Examples:
        //   "Eric Branley <eric@company.com>"   -> { fromEmail: "eric@company.com", fromName: "Eric Branley" }
        //   "eric@company.com"                  -> { fromEmail: "eric@company.com", fromName: "eric@company.com" }
        const fromHeader = from;
        const emailMatch = fromHeader.match(/<([^>]+)>/) || fromHeader.match(/([^\s<]+@[^\s>]+)/);
        const fromEmail = emailMatch ? emailMatch[1].trim() : fromHeader.trim();
        const fromName =
          fromHeader.replace(/<[^>]+>/, "").trim().replace(/^["']|["']$/g, "") || fromEmail;

        return {
          id: msg.id,
          subject,
          from: fromHeader,        // full string e.g. "Eric Branley <eric@company.com>"
          fromEmail,               // just eric@company.com
          fromName,                // just Eric Branley (or the address if no display name)
          to,
          date,
          body,
          internalDate: detail.data.internalDate || "0",
        };
      })
    );

    // Newest first by Gmail's internalDate (ms since epoch)
    emails.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));

    return Response.json({ emails });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { to, subject, body } = await req.json();

    const auth = getGmailClient();
    const gmail = google.gmail({ version: "v1", auth });

    const message = [
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\n");

    const encoded = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const sendResult = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });
    console.log("[/api/email POST] gmail send id:", sendResult.data?.id, "threadId:", sendResult.data?.threadId);

    return Response.json({ success: true, id: sendResult.data?.id, threadId: sendResult.data?.threadId });
  } catch (error) {
    console.log("[/api/email POST] FAILED:", error.message, "| code:", error.code, "| response:", JSON.stringify(error.response?.data));
    return Response.json(
      { success: false, error: error.message, code: error.code, details: error.response?.data },
      { status: 500 }
    );
  }
}
