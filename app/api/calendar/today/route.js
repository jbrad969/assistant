import { google } from "googleapis";

const TIME_ZONE = "America/Phoenix";

function getGoogleClient() {
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

function getDateRange(dateString) {
  const date = dateString ? new Date(dateString) : new Date();

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

function formatTime(dateString) {
  if (!dateString) return "All day";

  return new Date(dateString).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: TIME_ZONE,
  });
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const date = searchParams.get("date");

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: "v3", auth });

    const { timeMin, timeMax } = getDateRange(date);

    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      timeZone: TIME_ZONE,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
    });

    const events = (result.data.items || []).map((event) => ({
      title: event.summary || "Untitled event",
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      time: formatTime(event.start?.dateTime || event.start?.date),
      location: event.location || "",
    }));

    return Response.json({ events });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
