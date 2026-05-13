import { Composio } from "composio-core";

const composio = new Composio({ apiKey: process.env.COMPOSIO_API_KEY });

export async function POST(req) {
  try {
    const { action, params } = await req.json();

    const toolset = composio.getToolset();

    const result = await toolset.executeAction({
      action: action,
      params: params,
      entityId: "brad@solarfixaz.com",
    });

    return Response.json({ success: true, data: result });
  } catch (error) {
    console.log("GHL error:", error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") || "list";

    const toolset = composio.getToolset();

    if (action === "list") {
      const tools = await toolset.getTools({ apps: ["gohighlevel"] });
      return Response.json({
        tools: tools.map((t) => ({ name: t.name, description: t.description })),
      });
    }

    return Response.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
