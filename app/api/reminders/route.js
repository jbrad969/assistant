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

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ reminders: data || [] });
}

export async function POST(req) {
  const { message, remind_at } = await req.json();

  if (!message || !remind_at) {
    return Response.json(
      { error: "message and remind_at are required" },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("reminders")
    .insert([{ message, remind_at, triggered: false }])
    .select();

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ reminder: data?.[0] });
}

export async function PATCH(req) {
  const { id } = await req.json();
  if (!id) return Response.json({ error: "id required" }, { status: 400 });

  const { error } = await supabase
    .from("reminders")
    .update({ triggered: true })
    .eq("id", id);

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ success: true });
}
