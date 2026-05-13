const GHL_BASE = "https://rest.gohighlevel.com/v1";

async function ghlFetch(path, init = {}) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GHL_API_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const detail = body.message || body.error || text || "unknown";
    throw new Error(`GHL ${res.status}: ${detail}`);
  }
  return body;
}

const ACTIONS = {
  GOHIGHLEVEL_SEARCH_CONTACTS: ({ query }) => {
    const qs = new URLSearchParams({ query: query || "" });
    return ghlFetch(`/contacts/?${qs}`);
  },
  GOHIGHLEVEL_GET_CONTACT: ({ contactId }) => {
    if (!contactId) throw new Error("contactId is required");
    return ghlFetch(`/contacts/${contactId}`);
  },
  GOHIGHLEVEL_CREATE_NOTE: ({ contactId, body }) => {
    if (!contactId || !body) throw new Error("contactId and body are required");
    return ghlFetch(`/contacts/${contactId}/notes/`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },
  GOHIGHLEVEL_CREATE_OPPORTUNITY: ({ name, contactId, pipelineId, status }) => {
    if (!name || !contactId || !pipelineId) {
      throw new Error("name, contactId, and pipelineId are required");
    }
    return ghlFetch(`/pipelines/${pipelineId}/opportunities/`, {
      method: "POST",
      body: JSON.stringify({
        title: name,
        contactId,
        status: status || "open",
      }),
    });
  },
  GOHIGHLEVEL_SEND_SMS: ({ contactId, message }) => {
    if (!contactId || !message) throw new Error("contactId and message are required");
    return ghlFetch(`/conversations/messages`, {
      method: "POST",
      body: JSON.stringify({
        type: "SMS",
        contactId,
        message,
      }),
    });
  },
};

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") || "list";
    if (action === "list") {
      return Response.json({
        tools: Object.keys(ACTIONS).map((name) => ({
          name,
          description: `GHL action: ${name}`,
        })),
      });
    }
    return Response.json({ error: "Unknown GET action" }, { status: 400 });
  } catch (error) {
    console.log("GHL GET error:", error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { action, params } = await req.json();
    const handler = ACTIONS[action];
    if (!handler) {
      return Response.json(
        { success: false, error: `Unsupported action: ${action}` },
        { status: 400 }
      );
    }
    const data = await handler(params || {});
    console.log("GHL action:", action, "result:", JSON.stringify(data).slice(0, 500));
    return Response.json({ success: true, data });
  } catch (error) {
    console.log("GHL POST error:", error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
