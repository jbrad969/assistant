import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function GET() {
  const horizon = new Date(Date.now() + 60 * 60 * 1000);

  const { data, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("triggered", false)
    .lte("remind_at", horizon.toISOString())
    .order("remind_at", { ascending: true });

  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ reminders: data || [] });
}
