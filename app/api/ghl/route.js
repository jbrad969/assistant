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
  // /contacts/search doesn't support server-side date filtering, so when
  // dateFrom/dateTo are provided we pull pageLimit:50 and filter client-side.
  search_contact: async ({ query, dateFrom, dateTo }) => {
    const result = await ghlFetch(`/contacts/search`, {
      method: "POST",
      body: JSON.stringify({
        locationId: LOCATION_ID,
        query: query || "",
        pageLimit: 50,
      }),
    });
    if (!dateFrom && !dateTo) return result;
    const from = dateFrom ? new Date(dateFrom) : null;
    const to = dateTo ? new Date(dateTo) : null;
    const filtered = (result.contacts || []).filter((c) => {
      if (!c.dateAdded) return false;
      const added = new Date(c.dateAdded);
      if (from && added < from) return false;
      if (to && added > to) return false;
      return true;
    });
    filtered.sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded));
    return { ...result, contacts: filtered };
  },
  // Address search uses the same /contacts/search endpoint but with a
  // structured filter on the address1 field. Substring match via "contains"
  // means "Wild Burro" finds "6334 N Wild Burro Trail".
  search_by_address: ({ address }) => {
    if (!address) throw new Error("address is required");
    return ghlFetch(`/contacts/search`, {
      method: "POST",
      body: JSON.stringify({
        locationId: LOCATION_ID,
        filters: [{ field: "address1", operator: "contains", value: address }],
        pageLimit: 10,
      }),
    });
  },
  add_note: async ({ contactId, body }) => {
    if (!contactId || !body) throw new Error("contactId and body are required");
    console.log("Adding note to contact:", contactId, "body:", body);
    const result = await ghlFetch(`/contacts/${contactId}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    console.log("Note result:", JSON.stringify(result));
    return result;
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
  send_sms: async ({ contactId, message }) => {
    if (!contactId || !message) throw new Error("contactId and message are required");
    const body = { type: "SMS", contactId, message };
    console.log("SMS request body:", JSON.stringify(body));
    const res = await fetch(`${GHL_BASE}/conversations/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let result;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      result = { raw: text };
    }
    console.log("SMS response status:", res.status);
    console.log("SMS response:", JSON.stringify(result));
    if (!res.ok) {
      const detail = result.message || result.error || text || "unknown";
      throw new Error(`GHL ${res.status}: ${detail}`);
    }
    return result;
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
