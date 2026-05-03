"use client";

import { useEffect, useState } from "react";

export default function MemoryPage() {
  const [memories, setMemories] = useState([]);

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
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span>{memory.content}</span>

          <button onClick={() => deleteMemory(memory.id)}>
            Delete
          </button>
        </div>
      ))}
    </main>
  );
}
