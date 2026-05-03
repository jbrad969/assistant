"use client";

import { useState } from "react";

export default function Page() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hey Brad — I’m Jess. What do you need?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMessage = { role: "user", content: input };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: input }),
      });

      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply || "Jess had an issue." },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Jess could not connect. Try again." },
      ]);
    }

    setLoading(false);
  }

  return (
    <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1>Jess AI 🚀</h1>

      <div style={{ marginTop: 24 }}>
        {messages.map((msg, index) => (
          <div
            key={index}
            style={{
              marginBottom: 12,
              padding: 14,
              borderRadius: 10,
              background: msg.role === "user" ? "#dff0ff" : "#f2f2f2",
            }}
          >
            <strong>{msg.role === "user" ? "Brad" : "Jess"}:</strong>{" "}
            {msg.content}
          </div>
        ))}
      </div>

      {loading && <p>Jess is thinking...</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") sendMessage();
          }}
          placeholder="Ask Jess something..."
          style={{ flex: 1, padding: 12, fontSize: 16 }}
        />

        <button onClick={sendMessage} disabled={loading}>
          Send
        </button>
      </div>
    </main>
  );
}
