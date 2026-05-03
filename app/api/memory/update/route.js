import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function POST(req) {
  const { id, content } = await req.json();

  if (!id || !content) {
    return Response.json(
      { error: "Missing memory id or content" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("memory")
    .update({ content })
    .eq("id", id);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ success: true });
}
