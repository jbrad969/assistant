const GHL_BASE = "https://services.leadconnectorhq.com";
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const headers = {
  "Authorization": `Bearer ${process.env.GHL_API_KEY}`,
  "Content-Type": "application/json",
  "Version": "2021-07-28",
};

async function ghlFetch(path, init = {}) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data.message || data.error || text || "unknown";
    throw new Error(`GHL ${res.status}: ${detail}`);
  }
  return data;
}

const GET_ACTIONS = {
  get_contact: ({ contactId }) => {
    if (!contactId) throw new Error("contactId is required");
    return ghlFetch(`/contacts/${contactId}`);
  },
  list_contacts: () => {
    const qs = new URLSearchParams({ locationId: LOCATION_ID, limit: "10" });
    return ghlFetch(`/contacts/?${qs}`);
  },
  list_opportunities: () => {
    const qs = new URLSearchParams({ location_id: LOCATION_ID, limit: "10" });
    return ghlFetch(`/opportunities/search?${qs}`);
  },
  list_pipelines: () => {
    const qs = new URLSearchParams({ locationId: LOCATION_ID });
    return ghlFetch(`/opportunities/pipelines?${qs}`);
  },
};

const POST_ACTIONS = {
  // GHL v2 search is POST-only; sending GET to /contacts/search gets matched
  // to /contacts/{id} with id="search" → "Contact with id search not found".
  search_contact: ({ query }) => {
    return ghlFetch(`/contacts/search`, {
      method: "POST",
      body: JSON.stringify({
        locationId: LOCATION_ID,
        query: query || "",
        limit: 10,
      }),
    });
  },
  add_note: ({ contactId, body }) => {
    if (!contactId || !body) throw new Error("contactId and body are required");
    return ghlFetch(`/contacts/${contactId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  },
  create_opportunity: ({ contactId, name, pipelineId, pipelineStageId, status }) => {
    if (!contactId || !name || !pipelineId || !pipelineStageId) {
      throw new Error(
        "contactId, name, pipelineId, and pipelineStageId are required"
      );
    }
    return ghlFetch(`/opportunities/`, {
      method: "POST",
      body: JSON.stringify({
        locationId: LOCATION_ID,
        contactId,
        name,
        pipelineId,
        pipelineStageId,
        status: status || "open",
      }),
    });
  },
  send_sms: ({ contactId, message }) => {
    if (!contactId || !message) throw new Error("contactId and message are required");
    return ghlFetch(`/conversations/messages/outbound`, {
      method: "POST",
      body: JSON.stringify({ type: "SMS", contactId, message }),
    });
  },
  create_contact: ({ firstName, lastName, email, phone }) => {
    return ghlFetch(`/contacts/`, {
      method: "POST",
      body: JSON.stringify({
        locationId: LOCATION_ID,
        firstName,
        lastName,
        email,
        phone,
      }),
    });
  },
  update_contact: ({ contactId, fields }) => {
    if (!contactId || !fields) throw new Error("contactId and fields are required");
    return ghlFetch(`/contacts/${contactId}`, {
      method: "PUT",
      body: JSON.stringify(fields),
    });
  },
  create_task: ({ contactId, title, dueDate }) => {
    if (!contactId || !title) throw new Error("contactId and title are required");
    return ghlFetch(`/contacts/${contactId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title, dueDate }),
    });
  },
};

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action");
    const handler = GET_ACTIONS[action];
    if (!handler) {
      return Response.json(
        { success: false, error: `Unknown GET action: ${action}` },
        { status: 400 }
      );
    }
    const params = Object.fromEntries(searchParams.entries());
    const data = await handler(params);
    return Response.json({ success: true, data });
  } catch (error) {
    console.log("GHL GET error:", error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { action, params } = await req.json();
    const handler = POST_ACTIONS[action];
    if (!handler) {
      return Response.json(
        { success: false, error: `Unknown POST action: ${action}` },
        { status: 400 }
      );
    }
    const data = await handler(params || {});
    console.log("GHL POST", action, "→", JSON.stringify(data).slice(0, 500));
    return Response.json({ success: true, data });
  } catch (error) {
    console.log("GHL POST error:", error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
