import { google } from "googleapis";

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

function getTodayRange() {
  const now = new Date();

  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
  };
}

export async function GET() {
  try {
    const auth = getGoogleClient();
    const calendar = google.calendar({ version: "v3", auth });

    const { timeMin, timeMax } = getTodayRange();

    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 20,
    });

    const events = (result.data.items || []).map((event) => ({
      id: event.id,
      title: event.summary || "Untitled event",
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      location: event.location || "",
      description: event.description || "",
      link: event.htmlLink || "",
    }));

    return Response.json({ events });
  } catch (error) {
    return Response.json(
      { error: error.message || "Calendar error" },
      { status: 500 }
    );
  }
}
