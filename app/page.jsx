"use client";

import { useEffect, useRef, useState } from "react";

const styles = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0a0a0a;
    color: #f0f0f0;
    font-family: 'DM Sans', sans-serif;
  }

  .app {
    max-width: 780px;
    margin: 0 auto;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  /* HEADER */
  .header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: rgba(10,10,10,0.92);
    backdrop-filter: blur(16px);
    border-bottom: 1px solid #1f1f1f;
    padding: 16px 20px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .header-title {
    font-size: 18px;
    font-weight: 600;
    letter-spacing: -0.3px;
    color: #fff;
  }

  .header-sub {
    font-size: 11px;
    color: #555;
    margin-top: 2px;
    font-family: 'DM Mono', monospace;
    letter-spacing: 0.5px;
    text-transform: uppercase;
  }

  .header-actions {
    display: flex;
    gap: 8px;
  }

  .btn {
    background: transparent;
    color: #888;
    border: 1px solid #2a2a2a;
    padding: 7px 14px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    font-family: 'DM Sans', sans-serif;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .btn:hover {
    background: #1a1a1a;
    color: #fff;
    border-color: #333;
  }

  .btn.active {
    background: #fff;
    color: #000;
    border-color: #fff;
  }

  /* MEMORY PANEL */
  .memory-panel {
    margin: 12px 16px;
    padding: 20px;
    border-radius: 14px;
    background: #111;
    border: 1px solid #1f1f1f;
  }

  .memory-title {
    font-size: 13px;
    font-weight: 600;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-family: 'DM Mono', monospace;
    margin-bottom: 16px;
  }

  .memory-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 0;
    border-bottom: 1px solid #1a1a1a;
  }

  .memory-item:last-child {
    border-bottom: none;
  }

  .memory-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #444;
    margin-top: 6px;
    flex-shrink: 0;
  }

  .memory-content {
    flex: 1;
    font-size: 14px;
    color: #bbb;
    line-height: 1.5;
  }

  .memory-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }

  .memory-btn {
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #555;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 12px;
    cursor: pointer;
    font-family: 'DM Sans', sans-serif;
    transition: all 0.15s;
  }

  .memory-btn:hover {
    background: #1a1a1a;
    color: #fff;
  }

  .memory-btn.delete:hover {
    border-color: #ff4444;
    color: #ff4444;
  }

  .memory-input {
    width: 100%;
    background: #1a1a1a;
    border: 1px solid #333;
    color: #fff;
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 14px;
    font-family: 'DM Sans', sans-serif;
    outline: none;
  }

  .memory-input:focus {
    border-color: #555;
  }

  .memory-empty {
    font-size: 13px;
    color: #444;
    font-style: italic;
  }

  /* CHAT */
  .chat {
    flex: 1;
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .message-row {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .message-row.user {
    align-items: flex-end;
  }

  .message-row.assistant {
    align-items: flex-start;
  }

  .message-label {
    font-size: 11px;
    font-family: 'DM Mono', monospace;
    color: #444;
    margin-bottom: 4px;
    letter-spacing: 0.5px;
    padding: 0 4px;
  }

  .bubble {
    max-width: 78%;
    padding: 12px 16px;
    border-radius: 16px;
    font-size: 15px;
    line-height: 1.6;
    white-space: pre-wrap;
  }

  .bubble.user {
    background: #fff;
    color: #0a0a0a;
    border-bottom-right-radius: 4px;
    font-weight: 400;
  }

  .bubble.assistant {
    background: #141414;
    color: #e8e8e8;
    border: 1px solid #1f1f1f;
    border-bottom-left-radius: 4px;
  }

  .thinking {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: #141414;
    border: 1px solid #1f1f1f;
    border-radius: 16px;
    border-bottom-left-radius: 4px;
    width: fit-content;
  }

  .thinking-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #444;
    animation: pulse 1.2s ease-in-out infinite;
  }

  .thinking-dot:nth-child(2) { animation-delay: 0.2s; }
  .thinking-dot:nth-child(3) { animation-delay: 0.4s; }

  @keyframes pulse {
    0%, 100% { opacity: 0.3; transform: scale(0.8); }
    50% { opacity: 1; transform: scale(1); }
  }

  /* INPUT */
  .input-bar {
    padding: 16px;
    border-top: 1px solid #1a1a1a;
    background: rgba(10,10,10,0.95);
    position: sticky;
    bottom: 0;
  }

  .input-wrap {
    display: flex;
    gap: 10px;
    align-items: center;
    background: #141414;
    border: 1px solid #2a2a2a;
    border-radius: 14px;
    padding: 6px 6px 6px 16px;
    transition: border-color 0.15s;
  }

  .input-wrap:focus-within {
    border-color: #444;
  }

  .input-field {
    flex: 1;
    background: transparent;
    border: none;
    outline: none;
    color: #fff;
    font-size: 15px;
    font-family: 'DM Sans', sans-serif;
    padding: 6px 0;
  }

  .input-field::placeholder {
    color: #444;
  }

  .send-btn {
    background: #fff;
    color: #000;
    border: none;
    border-radius: 10px;
    padding: 10px 18px;
    font-size: 14px;
    font-weight: 600;
    font-family: 'DM Sans', sans-serif;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .send-btn:hover {
    background: #e0e0e0;
  }

  .send-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .mic-btn {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: transparent;
    border: 1px solid #2a2a2a;
    color: #888;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.15s;
    flex-shrink: 0;
    padding: 0;
  }

  .mic-btn:hover {
    background: #1a1a1a;
    color: #fff;
    border-color: #333;
  }

  .mic-btn svg {
    width: 18px;
    height: 18px;
  }

  .mic-btn.listening {
    background: #ff3b3b;
    color: #fff;
    border-color: #ff3b3b;
    animation: mic-pulse 1.2s ease-in-out infinite;
  }

  @keyframes mic-pulse {
    0%, 100% {
      box-shadow: 0 0 0 0 rgba(255, 59, 59, 0.7);
      transform: scale(1);
    }
    50% {
      box-shadow: 0 0 0 10px rgba(255, 59, 59, 0);
      transform: scale(1.05);
    }
  }

  .voice-bar {
    display: flex;
    justify-content: center;
    margin-bottom: 10px;
  }

  .stop-btn {
    background: #ff3b3b;
    color: #fff;
    border: none;
    border-radius: 24px;
    padding: 10px 20px 10px 16px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 10px;
    transition: background 0.15s;
    font-family: 'DM Sans', sans-serif;
    animation: stop-pulse 1.4s ease-in-out infinite;
  }

  .stop-btn:hover {
    background: #e02f2f;
  }

  .stop-btn::before {
    content: "";
    width: 11px;
    height: 11px;
    background: #fff;
    border-radius: 2px;
    display: inline-block;
  }

  @keyframes stop-pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 59, 59, 0.5); }
    50% { box-shadow: 0 0 0 8px rgba(255, 59, 59, 0); }
  }

  .reply-choice {
    display: flex;
    gap: 10px;
  }

  .reply-choice-btn {
    background: #141414;
    color: #e8e8e8;
    border: 1px solid #2a2a2a;
    border-radius: 20px;
    padding: 9px 18px;
    font-size: 13px;
    font-family: 'DM Sans', sans-serif;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .reply-choice-btn:hover {
    background: #1f1f1f;
    border-color: #555;
    color: #fff;
  }
`;

export default function Page() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Hey Brad — I'm Jess. What do you need?" },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [memories, setMemories] = useState([]);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [showReplyChoice, setShowReplyChoice] = useState(false);
  const bottomRef = useRef(null);
  const recognitionRef = useRef(null);
  const voiceRef = useRef(null);
  const inputRef = useRef(null);
  const isListeningRef = useRef(false);
  const micStreamRef = useRef(null);

  async function loadMemory() {
    const res = await fetch("/api/memory");
    const data = await res.json();
    setMemories(data.memories || []);
  }

  function stopListening() {
    if (!isListeningRef.current && !isListening) return;
    isListeningRef.current = false;
    try { recognitionRef.current?.stop(); } catch (e) {}
    setIsListening(false);
  }

  function formatMessage(text) {
    if (!text) return text;
    const timeRegex = /\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM|am|pm))\b/g;
    const matches = [...text.matchAll(timeRegex)];
    if (matches.length < 2) return text;

    const firstIdx = matches[0].index;
    const intro = text.slice(0, firstIdx).trim();

    const bullets = matches.map((m, i) => {
      const start = m.index;
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const segment = text.slice(start, end).trim().replace(/[,;]\s*$/, "");
      return `• ${segment}`;
    });

    return intro ? `${intro}\n\n${bullets.join("\n")}` : bullets.join("\n");
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    stopListening();

    const userText = input;
    setMessages((prev) => [...prev, { role: "user", content: userText }]);
    setInput("");
    setLoading(true);
    setShowReplyChoice(false);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, history: messages }),
      });

      const data = await res.json();
      const reply = data.reply || "Jess had an issue.";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: reply },
      ]);
      speak(reply);
      setShowReplyChoice(true);
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

  useEffect(() => { loadMemory(); }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (navigator.mediaDevices?.getUserMedia && !micStreamRef.current) {
      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          micStreamRef.current = stream;
        })
        .catch(() => {
          // user denied or unavailable; voice input will fail gracefully when invoked
        });
    }

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      recognition.onresult = (event) => {
        let transcript = "";
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        setInput(transcript);
      };
      recognition.onend = () => {
        if (isListeningRef.current) {
          try {
            recognition.start();
          } catch (e) {
            isListeningRef.current = false;
            setIsListening(false);
          }
        } else {
          setIsListening(false);
        }
      };
      recognition.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") {
          // let onend decide whether to restart
          return;
        }
        isListeningRef.current = false;
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }

    function pickVoice() {
      const voices = window.speechSynthesis?.getVoices() || [];
      if (!voices.length) return;
      const preferred = [
        "Google US English",
        "Samantha",
        "Microsoft Aria Online (Natural) - English (United States)",
        "Microsoft Jenny Online (Natural) - English (United States)",
        "Microsoft Zira - English (United States)",
        "Microsoft Zira Desktop - English (United States)",
      ];
      let voice = voices.find((v) => preferred.includes(v.name));
      if (!voice) voice = voices.find((v) => /female|samantha|zira|aria|jenny/i.test(v.name));
      if (!voice) voice = voices.find((v) => v.lang?.startsWith("en"));
      voiceRef.current = voice || voices[0];
    }
    pickVoice();
    if (window.speechSynthesis) {
      window.speechSynthesis.onvoiceschanged = pickVoice;
    }

    return () => {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach((t) => t.stop());
        micStreamRef.current = null;
      }
    };
  }, []);

  function speak(text) {
    if (typeof window === "undefined" || !window.speechSynthesis || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    if (voiceRef.current) utterance.voice = voiceRef.current;
    utterance.rate = 1;
    utterance.pitch = 1.05;
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    window.speechSynthesis.speak(utterance);
  }

  function stopSpeaking() {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }

  function chooseVoiceReply() {
    setShowReplyChoice(false);
    if (!isListening) toggleListening();
  }

  function chooseTextReply() {
    setShowReplyChoice(false);
    inputRef.current?.focus();
  }

  function toggleListening() {
    if (!recognitionRef.current) {
      alert("Voice input isn't supported in this browser. Try Chrome or Edge.");
      return;
    }
    if (isListening) {
      isListeningRef.current = false;
      try { recognitionRef.current.stop(); } catch (e) {}
      setIsListening(false);
      return;
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    setInput("");
    isListeningRef.current = true;
    try {
      recognitionRef.current.start();
      setIsListening(true);
    } catch (e) {
      isListeningRef.current = false;
      setIsListening(false);
    }
  }

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  return (
    <>
      <style>{styles}</style>
      <main className="app">

        {/* HEADER */}
        <header className="header">
          <div>
            <div className="header-title">Jess AI 🚀</div>
            <div className="header-sub">Brad's assistant</div>
          </div>
          <div className="header-actions">
            <button
              className="btn"
              onClick={() => {
                stopSpeaking();
                setShowReplyChoice(false);
                setMessages([{ role: "assistant", content: "Hey Brad — I'm Jess. What do you need?" }]);
              }}
            >
              Clear
            </button>
            <button
              className={`btn ${showMemory ? "active" : ""}`}
              onClick={() => setShowMemory(!showMemory)}
            >
              Memory
            </button>
          </div>
        </header>

        {/* MEMORY PANEL */}
        {showMemory && (
          <section className="memory-panel">
            <div className="memory-title">Memory</div>

            {memories.length === 0 && (
              <p className="memory-empty">No memories yet.</p>
            )}

            {memories.map((memory) => (
              <div key={memory.id} className="memory-item">
                <div className="memory-dot" />
                <div className="memory-content">
                  {editingId === memory.id ? (
                    <input
                      className="memory-input"
                      value={editingText}
                      onChange={(e) => setEditingText(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && updateMemory(memory.id)}
                      autoFocus
                    />
                  ) : (
                    memory.content
                  )}
                </div>
                <div className="memory-actions">
                  {editingId === memory.id ? (
                    <button className="memory-btn" onClick={() => updateMemory(memory.id)}>
                      Save
                    </button>
                  ) : (
                    <>
                      <button
                        className="memory-btn"
                        onClick={() => { setEditingId(memory.id); setEditingText(memory.content); }}
                      >
                        Edit
                      </button>
                      <button
                        className="memory-btn delete"
                        onClick={() => deleteMemory(memory.id)}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}

        {/* CHAT */}
        <section className="chat">
          {messages.map((msg, i) => (
            <div key={i} className={`message-row ${msg.role}`}>
              <div className="message-label">
                {msg.role === "user" ? "BRAD" : "JESS"}
              </div>
              <div className={`bubble ${msg.role}`}>
                {msg.role === "assistant" ? formatMessage(msg.content) : msg.content}
              </div>
            </div>
          ))}

          {loading && (
            <div className="message-row assistant">
              <div className="message-label">JESS</div>
              <div className="thinking">
                <div className="thinking-dot" />
                <div className="thinking-dot" />
                <div className="thinking-dot" />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </section>

        {/* INPUT */}
        <div className="input-bar">
          {isSpeaking && (
            <div className="voice-bar">
              <button className="stop-btn" onClick={stopSpeaking}>
                Stop Jess
              </button>
            </div>
          )}
          {showReplyChoice && !isSpeaking && !isListening && !loading && !input.trim() && (
            <div className="voice-bar">
              <div className="reply-choice">
                <button className="reply-choice-btn" onClick={chooseVoiceReply}>
                  Reply by Voice
                </button>
                <button className="reply-choice-btn" onClick={chooseTextReply}>
                  Reply by Text
                </button>
              </div>
            </div>
          )}
          <div className="input-wrap">
            <input
              ref={inputRef}
              className="input-field"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder={isListening ? "Listening..." : "Ask Jess..."}
            />
            <button
              type="button"
              className={`mic-btn ${isListening ? "listening" : ""}`}
              onClick={toggleListening}
              aria-label={isListening ? "Stop listening" : "Start voice input"}
              title={isListening ? "Stop listening" : "Start voice input"}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>
            <button
              className="send-btn"
              onClick={sendMessage}
              disabled={loading || !input.trim()}
            >
              Send
            </button>
          </div>
        </div>

      </main>
    </>
  );
}
