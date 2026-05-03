"use client";

import { useEffect, useState } from "react";

export default function Page() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hey Brad — I’m Jess. What do you need?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [showMemory, setShowMemory] = useState(false);
  const [memories, setMemories] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");

  async function loadMemory() {
    const res = await fetch("/api/memory");
    const data = await res.json();
    setMemories(data.memories || []);
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userText = input;
    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText }),
      });

      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply || "Jess had an issue." },
      ]);

      loadMemory();
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Browser error: " + error.message },
      ]);
    }

    setLoading(false);
  }

  async function deleteMemory(id) {
    await fetch("/api/memory/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    loadMemory();
  }

  async function updateMemory(id) {
    await fetch("/api/memory/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, content: editingText }),
    });

    setEditingId(null);
    setEditingText("");
    loadMemory();
  }

  useEffect(() => {
    loadMemory();
  }, []);

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1>Jess AI 🚀</h1>

        <button onClick={() => setShowMemory(!showMemory)}>
          {showMemory ? "Hide Memory" : "Show Memory"}
        </button>
      </div>

      {showMemory && (
        <section
          style={{
            marginBottom: 24,
            padding: 16,
            borderRadius: 12,
            background: "#fafafa",
            border: "1px solid #ddd",
          }}
        >
          <h2>Jess Memory 🧠</h2>

          {memories.length === 0 && <p>No memories saved yet.</p>}

          {memories.map((memory) => (
            <div
              key={memory.id}
              style={{
                padding: 12,
                marginBottom: 10,
                borderRadius: 8,
                background: "#f2f2f2",
              }}
            >
              {editingId === memory.id ? (
                <>
                  <input
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    style={{ width: "100%", padding: 10, marginBottom: 8 }}
                  />

                  <button onClick={() => updateMemory(memory.id)}>Save</button>
                  <button onClick={() => setEditingId(null)} style={{ marginLeft: 8 }}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <p>{memory.content}</p>

                  <button
                    onClick={() => {
                      setEditingId(memory.id);
                      setEditingText(memory.content);
                    }}
                  >
                    Edit
                  </button>

                  <button onClick={() => deleteMemory(memory.id)} style={{ marginLeft: 8 }}>
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </section>
      )}

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
          <strong>{msg.role === "user" ? "Brad" : "Jess"}:</strong> {msg.content}
        </div>
      ))}

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
