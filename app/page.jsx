"use client";

import { useState } from "react";

export default function Page() {
  const [message, setMessage] = useState("");
  const [response, setResponse] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendMessage() {
    if (!message.trim()) return;

    setLoading(true);
    setResponse("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });

      const data = await res.json();

      if (!res.ok) {
        setResponse(data.error || "Jess had an error.");
      } else {
        setResponse(data.reply || "Jess did not return a reply.");
      }
    } catch (error) {
      setResponse("Jess could not connect. Try again.");
    }

    setLoading(false);
  }

  return (
    <main style={{ padding: 40, maxWidth: 700 }}>
      <h1>Jess AI 🚀</h1>
      <p>Brad’s AI assistant is running.</p>

      <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
        <input
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask Jess something..."
          style={{
            flex: 1,
            padding: 12,
            fontSize: 16,
          }}
        />

        <button
          onClick={sendMessage}
          disabled={loading}
          style={{
            padding: "12px 18px",
            fontSize: 16,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Thinking..." : "Send"}
        </button>
      </div>

      {loading && <p style={{ marginTop: 20 }}>Jess is thinking...</p>}

      {response && (
        <div
          style={{
            marginTop: 24,
            padding: 16,
            background: "#f3f3f3",
            borderRadius: 8,
            whiteSpace: "pre-wrap",
          }}
        >
          {response}
        </div>
      )}
    </main>
  );
}
