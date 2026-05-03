import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export async function POST(req) {
  try {
    const { message } = await req.json();

    if (!message) {
      return Response.json({ reply: "Please type a message." });
    }

    const { data: memories, error: readError } = await supabase
      .from("memory")
      .select("id, content")
      .order("created_at", { ascending: true });

    if (readError) {
      return Response.json({ reply: "Supabase read error: " + readError.message });
    }

    const memoryText =
      memories && memories.length > 0
        ? memories.map((m) => `ID: ${m.id} | ${m.content}`).join("\n")
        : "No saved facts yet.";

    const factCheck = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You extract personal facts about Brad from messy user messages.

Return JSON only.

Existing memory:
${memoryText}

Schema:
{
  "action": "none" | "insert" | "update",
  "id": "existing memory id or null",
  "content": "clean fact or null"
}

Rules:
- If the message contains no useful personal fact, action = "none".
- If the fact is new, action = "insert".
- If the fact updates/replaces an existing fact, action = "update" and include the existing id.
- Do not create duplicates.
- Be forgiving with grammar and spelling.

Examples:
"my dogs name is frank" -> insert "Brad's dog's name is Frank"
"my favorite color is blue" -> insert "Brad's favorite color is Blue"
"my favorite color is red now" -> update existing favorite color fact
          `,
        },
        { role: "user", content: message },
      ],
      response_format: { type: "json_object" },
    });

    const memoryAction = JSON.parse(factCheck.choices[0].message.content);

    if (memoryAction.action === "insert" && memoryAction.content) {
      const { error: insertError } = await supabase
        .from("memory")
        .insert([{ content: memoryAction.content }]);

      if (insertError) {
        return Response.json({ reply: "Supabase insert error: " + insertError.message });
      }
    }

    if (memoryAction.action === "update" && memoryAction.id && memoryAction.content) {
      const { error: updateError } = await supabase
        .from("memory")
        .update({ content: memoryAction.content })
        .eq("id", memoryAction.id);

      if (updateError) {
        return Response.json({ reply: "Supabase update error: " + updateError.message });
      }
    }

    const { data: updatedMemories, error: secondReadError } = await supabase
      .from("memory")
      .select("content")
      .order("created_at", { ascending: true });

    if (secondReadError) {
      return Response.json({ reply: "Supabase second read error: " + secondReadError.message });
    }

    const updatedMemoryText =
      updatedMemories && updatedMemories.length > 0
        ? updatedMemories.map((m) => `- ${m.content}`).join("\n")
        : "No saved facts yet.";

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are Jess, Brad's AI assistant.

Stored facts:
${updatedMemoryText}

Rules:
- Treat stored facts as true.
- Use stored facts to answer directly.
- Never invent facts.
- Be concise and helpful.
          `,
        },
        { role: "user", content: message },
      ],
    });

    return Response.json({
      reply: completion.choices[0].message.content,
    });
  } catch (err) {
    return Response.json(
      { reply: "Server error: " + err.message },
      { status: 500 }
    );
  }
}
