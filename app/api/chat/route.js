import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req) {
  try {
    const { message } = await req.json();

    const historyRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/messages?select=role,content&order=created_at.asc`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );

    if (!historyRes.ok) {
      const errorText = await historyRes.text();
      return Response.json(
        { error: "Supabase read failed: " + errorText },
        { status: 500 }
      );
    }

    const history = await historyRes.json();

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are Jess, Brad's AI assistant. You remember past conversations and answer clearly.",
        },
        ...history,
        { role: "user", content: message },
      ],
    });

    const reply = completion.choices[0].message.content;

    const saveUser = await fetch(`${process.env.SUPABASE_URL}/rest/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ role: "user", content: message }),
    });

    if (!saveUser.ok) {
      const errorText = await saveUser.text();
      return Response.json(
        { error: "Supabase user save failed: " + errorText },
        { status: 500 }
      );
    }

    const saveAssistant = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ role: "assistant", content: reply }),
      }
    );

    if (!saveAssistant.ok) {
      const errorText = await saveAssistant.text();
      return Response.json(
        { error: "Supabase assistant save failed: " + errorText },
        { status: 500 }
      );
    }

    return Response.json({ reply });
  } catch (error) {
    return Response.json(
      { error: error.message || "Unknown server error" },
      { status: 500 }
    );
  }
}
