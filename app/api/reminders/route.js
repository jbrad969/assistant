import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function GET() {
  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("triggered", false)
    .order("remind_at", { ascending: true });

  if (error) {
    console.log("[/api/reminders GET] supabase error:", error.message, error.details, error.hint);
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ reminders: data || [] });
}

export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    console.log("[/api/reminders POST] invalid JSON body:", e.message);
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { message, remind_at } = body || {};
  console.log("[/api/reminders POST] body:", JSON.stringify(body));

  if (!message || !remind_at) {
    console.log("[/api/reminders POST] missing fields; message=", message, "remind_at=", remind_at);
    return Response.json(
      { error: "message and remind_at are required" },
      { status: 400 }
    );
  }

  console.log(`Saving reminder: "${message}" at ${remind_at}`);

  const { data, error } = await supabase
    .from("reminders")
    .insert([{ message, remind_at, triggered: false }])
    .select();

  if (error) {
    console.log(
      "Reminder save FAILED:",
      error.message,
      "| code:", error.code,
      "| details:", error.details,
      "| hint:", error.hint
    );
    return Response.json(
      {
        error: error.message,
        code: error.code,
        details: error.details,
        hint: error.hint,
      },
      { status: 500 }
    );
  }

  console.log("Reminder saved successfully:", data?.[0]?.id);
  return Response.json({ reminder: data?.[0], success: true });
}

export async function PATCH(req) {
  const { id } = await req.json();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase
    .from("reminders")
    .update({ triggered: true })
    .eq("id", id);

  if (error) {
    console.log("[/api/reminders PATCH] supabase error:", error.message, error.details);
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ success: true });
}
