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
    const limit = searchParams.get("limit") || "5";
    const all = searchParams.get("all") === "true";
    const search = searchParams.get("search");
    const fullBody = searchParams.get("full") === "true";

    const auth = getGmailClient();
    const gmail = google.gmail({ version: "v1", auth });

    const listRes = await gmail.users.messages.list({
      userId: "me",
      q: search || "is:unread",
      maxResults: all ? 50 : parseInt(limit),
    });

    const messages = listRes.data.messages || [];

    if (messages.length === 0) {
      return Response.json({ emails: [], text: "No unread emails." });
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

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encoded },
    });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
