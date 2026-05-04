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

function getDateRange(dateString, days = 1) {
  const timeZone = "America/Phoenix";

  // Parse the target date
  const date = dateString ? new Date(dateString) : new Date();

  // Get the date parts in Phoenix timezone
  const phoenixStr = date.toLocaleDateString("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [month, day, year] = phoenixStr.split("/");

  // Build start of that day in Phoenix time (UTC-7, no DST)
  const startDate = new Date(`${year}-${month}-${day}T00:00:00-07:00`);
  const timeMin = startDate.toISOString();

  // End is N days later at 23:59:59 Phoenix (single-day default matches user's spec exactly).
  const endMs = startDate.getTime() + days * 24 * 60 * 60 * 1000 - 1000;
  const timeMax = new Date(endMs).toISOString();

  return { timeMin, timeMax };
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
    const days = Math.max(1, Math.min(30, parseInt(searchParams.get("days") || "1", 10)));
    const searchTitle = searchParams.get("searchTitle");

    console.log("Calendar API called for date:", date, "days:", days, "searchTitle:", searchTitle);
    console.log(
      "Auth credentials present:",
      !!process.env.GOOGLE_CLIENT_ID,
      !!process.env.GOOGLE_REFRESH_TOKEN
    );

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: "v3", auth });

    // Print the actual scopes attached to this refresh token so we can verify
    // it has https://www.googleapis.com/auth/calendar (or .readonly) on it.
    try {
      const accessTokenResponse = await auth.getAccessToken();
      const accessToken =
        typeof accessTokenResponse === "string"
          ? accessTokenResponse
          : accessTokenResponse?.token;
      if (accessToken) {
        const tokenInfo = await auth.getTokenInfo(accessToken);
        console.log("Token scopes:", tokenInfo.scopes);
      } else {
        console.log("Token scopes: (no access token resolved)");
      }
    } catch (e) {
      console.log("Token info check failed:", e.message);
    }

    const { timeMin, timeMax } = getDateRange(date, days);
    console.log("Fetching calendar for:", { timeMin, timeMax, date });

    const result = await calendar.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      timeZone: TIME_ZONE,
      singleEvents: true,
      orderBy: "startTime",
      maxResults: days > 1 ? 250 : 50,
      fields: "items(id,summary,start,end,location,description,attendees,organizer)",
    });

    console.log("Calendar API returned", (result.data.items || []).length, "raw items");
    console.log("FULL FIRST EVENT:", JSON.stringify(result.data.items?.[0], null, 2));
    console.log("RAW EVENT ATTENDEES:", JSON.stringify(result.data.items?.[0]?.attendees));
    console.log("RAW EVENT ORGANIZER:", JSON.stringify(result.data.items?.[0]?.organizer));
    console.log("RAW EVENT KEYS:", JSON.stringify(Object.keys(result.data.items?.[0] || {})));

    let events = (result.data.items || []).map((event) => ({
      id: event.id,
      title: event.summary || "Untitled event",
      start: event.start?.dateTime || event.start?.date,
      end: event.end?.dateTime || event.end?.date,
      time: formatTime(event.start?.dateTime || event.start?.date),
      location: event.location || "",
      description: event.description || "",
      attendees: (event.attendees || []).map((a) => ({
        name: a.displayName || "",
        email: a.email || "",
      })),
      organizer: {
        name: event.organizer?.displayName || "",
        email: event.organizer?.email || "",
      },
    }));

    if (searchTitle) {
      const q = searchTitle.toLowerCase();
      events = events.filter((e) => (e.title || "").toLowerCase().includes(q));
    }

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
    console.log("Calendar API FAILED:", error.message);
    return Response.json(
      { events: [], error: "Calendar API failed", details: error.message },
      { status: 500 }
    );
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

async function logTokenScopes(auth) {
  try {
    const tokenResponse = await auth.getAccessToken();
    const accessToken =
      typeof tokenResponse === "string" ? tokenResponse : tokenResponse?.token;
    if (accessToken) {
      const tokenInfo = await auth.getTokenInfo(accessToken);
      console.log("Token scopes:", tokenInfo.scopes);
    } else {
      console.log("Token scopes: (no access token resolved)");
    }
  } catch (e) {
    console.log("Token info check failed:", e.message);
  }
}

export async function DELETE(req) {
  try {
    const { eventId } = await req.json();
    if (!eventId) {
      return Response.json({ error: "eventId is required" }, { status: 400 });
    }

    console.log("Attempting DELETE for event ID:", eventId);
    console.log("Calendar ID: primary");

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: "v3", auth });
    await logTokenScopes(auth);

    const deleteResult = await calendar.events.delete({
      calendarId: "primary",
      eventId,
    });
    console.log(
      "DELETE result:",
      JSON.stringify({ status: deleteResult.status, statusText: deleteResult.statusText, data: deleteResult.data })
    );

    return Response.json({ success: true });
  } catch (error) {
    console.log(
      "DELETE FAILED:",
      error.message,
      "| code:", error.code,
      "| errors:", JSON.stringify(error.errors),
      "| response:", JSON.stringify(error.response?.data)
    );
    return Response.json(
      { error: error.message, code: error.code, details: error.errors || error.response?.data },
      { status: 500 }
    );
  }
}

export async function PATCH(req) {
  try {
    const { eventId, title, start, end, durationMinutes, location } = await req.json();
    if (!eventId) {
      return Response.json({ error: "eventId is required" }, { status: 400 });
    }

    const updateBody = {};
    if (title) updateBody.summary = title;
    if (location !== undefined) updateBody.location = location || null;
    if (start?.date && start?.time) updateBody.start = buildDateTime(start);
    if (end?.date && end?.time) {
      updateBody.end = buildDateTime(end);
    } else if (start?.date && start?.time && durationMinutes) {
      updateBody.end = buildDateTime(addMinutes(start, durationMinutes));
    }

    console.log("Attempting PATCH for event ID:", eventId);
    console.log("PATCH body:", JSON.stringify(updateBody));

    const auth = getGoogleClient();
    const calendar = google.calendar({ version: "v3", auth });
    await logTokenScopes(auth);

    const patchResult = await calendar.events.patch({
      calendarId: "primary",
      eventId,
      requestBody: updateBody,
    });
    console.log(
      "PATCH result:",
      JSON.stringify({
        status: patchResult.status,
        statusText: patchResult.statusText,
        id: patchResult.data?.id,
        updated: patchResult.data?.updated,
        start: patchResult.data?.start,
        end: patchResult.data?.end,
      })
    );

    return Response.json({ success: true, eventId: patchResult.data.id });
  } catch (error) {
    console.log(
      "PATCH FAILED:",
      error.message,
      "| code:", error.code,
      "| errors:", JSON.stringify(error.errors),
      "| response:", JSON.stringify(error.response?.data)
    );
    return Response.json(
      { error: error.message, code: error.code, details: error.errors || error.response?.data },
      { status: 500 }
    );
  }
}
