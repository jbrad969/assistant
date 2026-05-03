import { google } from "googleapis";

const TIME_ZONE = "America/Phoenix";
const BUFFER_MINUTES = 10;
const DEFAULT_ORIGIN = "Phoenix, AZ";

function getGoogleClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

async function findNextEventWithLocation() {
  const auth = getGoogleClient();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const horizon = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const result = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: horizon.toISOString(),
    timeZone: TIME_ZONE,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });

  const events = result.data.items || [];
  return (
    events.find((event) => {
      if (!event.location || !event.start?.dateTime) return false;
      return new Date(event.start.dateTime).getTime() > Date.now();
    }) || null
  );
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const origin = searchParams.get("origin") || DEFAULT_ORIGIN;

    const event = await findNextEventWithLocation();
    if (!event) {
      return Response.json({
        noEvent: true,
        message: "No upcoming events with a location in the next 24 hours",
      });
    }

    const eventStart = event.start.dateTime;

    const params = new URLSearchParams({
      origin,
      destination: event.location,
      arrivalTime: eventStart,
    });
    const mapsRes = await fetch(
      `${process.env.NEXT_PUBLIC_BASE_URL}/api/maps?${params.toString()}`
    );
    const mapsData = await mapsRes.json();

    if (mapsData.error) {
      return Response.json(
        { error: mapsData.error, event: { title: event.summary, location: event.location, start: eventStart } },
        { status: 502 }
      );
    }

    const driveTimeMinutes = mapsData.driveTimeMinutes;
    const trafficDelayMinutes = mapsData.trafficDelayMinutes;

    const eventStartMs = new Date(eventStart).getTime();
    const departureMs = eventStartMs - (driveTimeMinutes + BUFFER_MINUTES) * 60 * 1000;
    const minutesUntilDeparture = Math.round((departureMs - Date.now()) / 60000);
    const needsToLeaveNow = minutesUntilDeparture <= 0;

    return Response.json({
      needsToLeaveNow,
      minutesUntilDeparture,
      driveTimeMinutes,
      trafficDelayMinutes,
      distance: mapsData.distance,
      bufferMinutes: BUFFER_MINUTES,
      departureTime: new Date(departureMs).toISOString(),
      event: {
        title: event.summary || "Untitled event",
        start: eventStart,
        location: event.location,
      },
      origin: mapsData.origin || origin,
      timeZone: TIME_ZONE,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
