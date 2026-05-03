// Required env vars:
// - GOOGLE_MAPS_API_KEY: Google Cloud API key with the Distance Matrix API enabled
//   (Google Cloud Console -> APIs & Services -> Library -> Distance Matrix API)

const TIME_ZONE = "America/Phoenix";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const origin = searchParams.get("origin");
    const destination = searchParams.get("destination");
    const arrivalTime = searchParams.get("arrivalTime");

    if (!origin || !destination) {
      return Response.json(
        { error: "origin and destination are required" },
        { status: 400 }
      );
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    console.log("[maps] GOOGLE_MAPS_API_KEY present:", !!apiKey);
    if (!apiKey) {
      return Response.json(
        { error: "GOOGLE_MAPS_API_KEY is not configured" },
        { status: 500 }
      );
    }

    const params = new URLSearchParams({
      origins: origin,
      destinations: destination,
      departure_time: "now",
      traffic_model: "best_guess",
      mode: "driving",
      units: "imperial",
      key: apiKey,
    });

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    console.log("[maps] requesting:", url.replace(apiKey, "***"));
    const res = await fetch(url);
    const data = await res.json();
    console.log("[maps] status:", data.status, "element:", data.rows?.[0]?.elements?.[0]?.status);

    if (data.status !== "OK") {
      return Response.json(
        { error: `Maps API error: ${data.status} ${data.error_message || ""}`.trim() },
        { status: 502 }
      );
    }

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") {
      return Response.json(
        { error: `No route found: ${element?.status || "unknown"}` },
        { status: 404 }
      );
    }

    const driveSeconds = element.duration_in_traffic?.value ?? element.duration?.value;
    const driveSecondsNoTraffic = element.duration?.value;
    const driveTimeMinutes = Math.round(driveSeconds / 60);
    const driveTimeWithoutTrafficMinutes = Math.round(driveSecondsNoTraffic / 60);
    const trafficDelayMinutes = Math.max(0, driveTimeMinutes - driveTimeWithoutTrafficMinutes);

    let departureTime = null;
    let minutesUntilDeparture = null;
    if (arrivalTime) {
      const arrivalMs = new Date(arrivalTime).getTime();
      if (!Number.isNaN(arrivalMs)) {
        const departureMs = arrivalMs - driveSeconds * 1000;
        departureTime = new Date(departureMs).toISOString();
        minutesUntilDeparture = Math.round((departureMs - Date.now()) / 60000);
      }
    }

    return Response.json({
      driveTimeMinutes,
      driveTimeWithoutTrafficMinutes,
      trafficDelayMinutes,
      distance: element.distance?.text,
      distanceMeters: element.distance?.value,
      origin: data.origin_addresses?.[0] || origin,
      destination: data.destination_addresses?.[0] || destination,
      departureTime,
      minutesUntilDeparture,
      timeZone: TIME_ZONE,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
