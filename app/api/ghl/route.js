import { Composio } from "composio-core";
import { CloudflareToolSet } from "composio-core";

const composio = new Composio(process.env.COMPOSIO_API_KEY);

export async function GET(req) {
  try {
    const toolset = new CloudflareToolSet({ apiKey: process.env.COMPOSIO_API_KEY });
    const tools = await toolset.getTools({ apps: ["gohighlevel"] });
    return Response.json({
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
    });
  } catch (error) {
    console.log("GHL GET error:", error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { action, params } = await req.json();
    const toolset = new CloudflareToolSet({ apiKey: process.env.COMPOSIO_API_KEY });

    const result = await toolset.executeAction(
      action,
      params,
      "brad@solarfixaz.com"
    );

    console.log("GHL action result:", JSON.stringify(result));
    return Response.json({ success: true, data: result });
  } catch (error) {
    console.log("GHL POST error:", error.message);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
}
