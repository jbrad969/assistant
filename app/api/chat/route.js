import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getMemory() {
  const { data, error } = await supabase
    .from("memory")
    .select("content");

  if (error || !data) return "";

  return data.map((m) => m.content).join("\n");
}

export async function POST(req) {
  try {
    const { message } = await req.json();

    const memory = await getMemory();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

You have access to Brad's personal memory.

Memory:
${memory}

Use this memory to answer personal questions like:
- dog's name
- preferences
- personal info

Be confident and direct.
          `,
        },
        {
          role: "user",
          content: message,
        },
      ],
    });

    return Response.json({
      reply: completion.choices[0].message.content,
    });
  } catch (error) {
    return Response.json({
      reply: "Jess had an issue.",
      error: error.message,
    });
  }
}
