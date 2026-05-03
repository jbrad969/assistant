"use client";

import { useEffect, useState } from "react";

export default function MemoryPage() {
  const [memories, setMemories] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");

  async function loadMemory() {
    const res = await fetch("/api/memory");
    const data = await res.json();
    setMemories(data.memories || []);
  }

  async function deleteMemory(id) {
    await fetch("/api/memory/delete", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id }),
    });

    loadMemory();
  }

  async function updateMemory(id) {
    await fetch("/api/memory/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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
    <main style={{ maxWidth: 800, margin: "0 auto", padding: 24 }}>
      <h1>Jess Memory 🧠</h1>

      {memories.length === 0 && <p>No memories saved yet.</p>}

      {memories.map((memory) => (
        <div
          key={memory.id}
          style={{
            padding: 14,
            marginBottom: 12,
            borderRadius: 10,
            background: "#f2f2f2",
          }}
        >
          {editingId === memory.id ? (
            <>
              <input
                value={editingText}
                onChange={(e) => setEditingText(e.target.value)}
                style={{
                  width: "100%",
                  padding: 10,
                  fontSize: 16,
                  marginBottom: 8,
                }}
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

              <button
                onClick={() => deleteMemory(memory.id)}
                style={{ marginLeft: 8 }}
              >
                Delete
              </button>
            </>
          )}
        </div>
      ))}
    </main>
  );
}
