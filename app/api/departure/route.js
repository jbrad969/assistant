import { google } from "googleapis";

const TIME_ZONE = "America/Phoenix";
const BUFFER_MINUTES = 10;
const DEFAULT_ORIGIN = "4139 East Desert Sands Place Chandler AZ";

function getGoogleClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return client;
}

function formatFriendlyDeparture(departureMs, nowMs) {
  const minutesUntil = Math.round((departureMs - nowMs) / 60000);
  if (minutesUntil <= 0) return "right now";
  if (minutesUntil <= 60) return `in ${minutesUntil} minute${minutesUntil === 1 ? "" : "s"}`;

  const dep = new Date(departureMs);
  const now = new Date(nowMs);
  const tomorrow = new Date(nowMs + 24 * 60 * 60 * 1000);

  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIME_ZONE,
  });
  const timeFmt = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: TIME_ZONE,
  });

  const depDate = dateFmt.format(dep);
  const todayDate = dateFmt.format(now);
  const tomorrowDate = dateFmt.format(tomorrow);
  const timeStr = timeFmt.format(dep);

  if (depDate === todayDate) return `at ${timeStr} today`;
  if (depDate === tomorrowDate) return `tomorrow at ${timeStr}`;

  const dayName = new Intl.DateTimeFormat("en-US", {
    weekday: "long", timeZone: TIME_ZONE,
  }).format(dep);
  return `${dayName} at ${timeStr}`;
}

async function findNextEventWithLocation(eventQuery = null) {
  const auth = getGoogleClient();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date();
  const horizonDays = eventQuery ? 7 : 1;
  const horizon = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);

  const result = await calendar.events.list({
    calendarId: "primary",
    timeMin: now.toISOString(),
    timeMax: horizon.toISOString(),
    timeZone: TIME_ZONE,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 100,
  });

  const events = result.data.items || [];
  const upcoming = events.filter((event) => {
    if (!event.location || !event.start?.dateTime) return false;
    return new Date(event.start.dateTime).getTime() > Date.now();
  });

  if (eventQuery) {
    const q = eventQuery.toLowerCase();
    return (
      upcoming.find((event) => (event.summary || "").toLowerCase().includes(q)) ||
      null
    );
  }

  return upcoming[0] || null;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const origin = searchParams.get("origin") || DEFAULT_ORIGIN;
    const eventQuery = searchParams.get("eventQuery");

    const event = await findNextEventWithLocation(eventQuery);
    if (!event) {
      if (eventQuery) {
        console.log("[departure] no event match for query:", eventQuery);
        return Response.json({
          noEventMatch: true,
          query: eventQuery,
          message: `No event matching "${eventQuery}" found in the next 7 days`,
        });
      }
      console.log("[departure] no upcoming event with a location");
      return Response.json({
        noEvent: true,
        message: "No upcoming events with a location in the next 24 hours",
      });
    }

    const eventStart = event.start.dateTime;
    console.log("[departure] next event:", event.summary, "@", event.location, "start:", eventStart);

    const params = new URLSearchParams({
      origin,
      destination: event.location,
      arrivalTime: eventStart,
    });
    const mapsUrl = `${process.env.NEXT_PUBLIC_BASE_URL}/api/maps?${params.toString()}`;
    const mapsRes = await fetch(mapsUrl);
    const mapsData = await mapsRes.json();
    console.log("[departure] maps response:", JSON.stringify(mapsData));

    if (mapsData.error) {
      return Response.json(
        { error: mapsData.error, event: { title: event.summary, location: event.location, start: eventStart } },
        { status: 502 }
      );
    }

    const driveTimeMinutes = mapsData.driveTimeMinutes;
    const trafficDelayMinutes = mapsData.trafficDelayMinutes;

    const nowMs = Date.now();
    const eventStartMs = new Date(eventStart).getTime();
    const departureMs = eventStartMs - (driveTimeMinutes + BUFFER_MINUTES) * 60 * 1000;
    const minutesUntilDeparture = Math.round((departureMs - nowMs) / 60000);
    const needsToLeaveNow = minutesUntilDeparture <= 0;
    const friendlyDepartureTime = formatFriendlyDeparture(departureMs, nowMs);

    return Response.json({
      needsToLeaveNow,
      minutesUntilDeparture,
      friendlyDepartureTime,
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
