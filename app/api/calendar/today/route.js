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

  // Resolve the Phoenix-local Y-M-D for the given moment, regardless of server timezone.
  // en-CA formats as YYYY-MM-DD which we can concatenate directly.
  const phoenixDate = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TIME_ZONE,
  }).format(date);

  // Phoenix is fixed UTC-7 (never observes DST). Midnight Phoenix == 07:00 UTC of the same date.
  const start = new Date(`${phoenixDate}T07:00:00Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

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

function sortEvents(events) {
  return events.sort((a, b) => {
    const aTime = new Date(a.start).getTime();
    const bTime = new Date(b.start).getTime();
    return aTime - bTime;
  });
}

function addMinutes({ date, time }, minutes) {
  const [hh, mm] = time.split(":").map(Number);
  let total = hh * 60 + mm + minutes;
  let dayOffset = 0;
  while (total >= 24 * 60) {
    total -= 24 * 60;
    dayOffset += 1;
  }
  while (total < 0) {
    total += 24 * 60;
    dayOffset -= 1;
  }
  let endDate = date;
  if (dayOffset !== 0) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + dayOffset);
    endDate = d.toISOString().slice(0, 10);
  }
  const newH = Math.floor(total / 60);
  const newM = total % 60;
  return {
    date: endDate,
    time: `${String(newH).padStart(2, "0")}:${String(newM).padStart(2, "0")}`,
  };
}

function buildDateTime({ date, time }) {
  return { dateTime: `${date}T${time}:00`, timeZone: TIME_ZONE };
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

    let events = (result.data.items || []).map((event) => ({
      id: event.id,
      title: event.summary || "Untitled event",
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      time: formatTime(event.start?.dateTime || event.start?.date),
      location: event.location || "",
    }));

    events = sortEvents(events);

    // 🔥 THIS IS THE IMPORTANT PART
    const formatted = events.map((event) => {
      const location = event.location ? ` — ${event.location}` : "";
      return `${event.time} — ${event.title}${location}`;
    });

    return Response.json({
      events,
      text: formatted.join("\n"), // <-- CLEAN MULTI-LINE OUTPUT
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { title, start, end, durationMinutes, location, description } = await req.json();

    if (!title || !start?.date || !start?.time) {
      return Response.json(
        { error: "title, start.date, and start.time are required" },
        { status: 400 }
      );
    }

    const finalEnd = end?.date && end?.time ? end : addMinutes(start, durationMinutes || 60);

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: "v3", auth });

    const result = await calendar.events.insert({
      calendarId: "primary",
      requestBody: {
        summary: title,
        location: location || undefined,
        description: description || undefined,
        start: buildDateTime(start),
        end: buildDateTime(finalEnd),
      },
    });

    return Response.json({
      success: true,
      eventId: result.data.id,
      htmlLink: result.data.htmlLink,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    const { eventId } = await req.json();
    if (!eventId) {
      return Response.json({ error: "eventId is required" }, { status: 400 });
    }

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.delete({ calendarId: "primary", eventId });

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(req) {
  try {
    const { eventId, title, start, end, durationMinutes, location } = await req.json();
    if (!eventId) {
      return Response.json({ error: "eventId is required" }, { status: 400 });
    }

    const requestBody = {};
    if (title) requestBody.summary = title;
    if (location !== undefined) requestBody.location = location || null;
    if (start?.date && start?.time) requestBody.start = buildDateTime(start);
    if (end?.date && end?.time) {
      requestBody.end = buildDateTime(end);
    } else if (start?.date && start?.time && durationMinutes) {
      requestBody.end = buildDateTime(addMinutes(start, durationMinutes));
    }

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: "v3", auth });

    const result = await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody,
    });

    return Response.json({ success: true, eventId: result.data.id });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
