import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { MODELS, safeReadInstalledModelIds } from "./modelCatalog";


type ChatRole = "user" | "assistant";

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  selectedModel?: LocalModel | null | undefined;
};

type LocalModel = {
  id: string;
  huggingfaceId: string;
  detail?: string;
};

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function Chat() {
  const [refreshKeyLocal, setRefreshKeyLocal] = useState(0);

  const models: LocalModel[] = useMemo(() => {
    const installed = safeReadInstalledModelIds();
    const installedModels = MODELS.filter((m) => installed.includes(m.id)).map(
      (m) => ({ id: m.id, huggingfaceId: m.huggingfaceId, detail: "Local" })
    );
    if (installedModels.length > 0) return installedModels;

    // Fallback so Chat works before any installs.
    return MODELS.slice(0, 3).map((m) => ({
      id: m.id,
      huggingfaceId: m.huggingfaceId,
      detail: "Local",
    }));
  }, [refreshKeyLocal]);

  useEffect(() => {
    const handleUpdateChat = () => {
      setRefreshKeyLocal((prev) => prev + 1);
    };

    window.addEventListener("lucasmengarda::updateChat", handleUpdateChat);
    return () => {
      window.removeEventListener(
        "lucasmengarda::updateChat",
        handleUpdateChat
      );
    };
  }, []);

  const [selectedModelId, setSelectedModelId] = useState(models[0]?.id ?? "");
  const selectedModel = models.find((m) => m.id === selectedModelId);

  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: createId(),
      role: "assistant",
      content:
        "Hello! I am your local AI assistant. How can I help you today?",
      createdAt: Date.now(),
    },
  ]);

  const [draft, setDraft] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(
    null
  );
  const [updateChatScrolltop, setUpdateChatScrolltop] = useState(0);
  const activeGenerationIdRef = useRef<string | null>(null);
  const activeAssistantMessageIdRef = useRef<string | null>(null);
  const selectedModelRef = useRef<LocalModel | undefined>(undefined);

  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, isThinking, updateChatScrolltop]);

  useEffect(() => {
    activeGenerationIdRef.current = activeGenerationId;
  }, [activeGenerationId]);

  useEffect(() => {
    selectedModelRef.current = selectedModel;
  }, [selectedModel]);

  useEffect(() => {
    let disposed = false;
    let unlistenToken: null | (() => void) = null;
    let unlistenDone: null | (() => void) = null;
    let unlistenError: null | (() => void) = null;

    (async () => {
      unlistenToken = await listen<{
        generation_id: string;
        token: string;
      }>("cerebro:chat_token", (event) => {
        const gen = event.payload?.generation_id;
        if (!gen || gen !== activeGenerationIdRef.current) return;
        const assistantId = activeAssistantMessageIdRef.current;
        if (!assistantId) return;
        const token = event.payload?.token ?? "";
        if (!token) return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + token } : m
          )
        );
        setUpdateChatScrolltop((prev) => prev + 1);
      });

      // For React Dev online where it mount/unmount twice.
      if (disposed) {
        unlistenToken();
        unlistenToken = null;
        return;
      }

      unlistenDone = await listen<{ generation_id: string }>(
        "cerebro:chat_done",
        (event) => {
          const gen = event.payload?.generation_id;
          if (!gen || gen !== activeGenerationIdRef.current) return;
          setIsThinking(false);
          setActiveGenerationId(null);
          activeAssistantMessageIdRef.current = null;
        }
      );

      if (disposed) {
        unlistenDone();
        unlistenDone = null;
        return;
      }

      unlistenError = await listen<{
        generation_id: string | null;
        message: string;
      }>("cerebro:chat_error", (event) => {
        const gen = event.payload?.generation_id;
        // If generation_id is null, treat as global runner error.
        if (gen && gen !== activeGenerationIdRef.current) return;

        const message = event.payload?.message ?? "Unknown error";
        setMessages((prev) => [
          ...prev,
          {
            id: createId(),
            role: "assistant",
            selectedModel: selectedModelRef.current,
            content: `Error: ${message}`,
            createdAt: Date.now(),
          },
        ]);

        setIsThinking(false);
        setActiveGenerationId(null);
        activeAssistantMessageIdRef.current = null;
      });

      if (disposed) {
        unlistenError();
        unlistenError = null;
      }
    })();

    return () => {
      disposed = true;
      if (unlistenToken) unlistenToken();
      if (unlistenDone) unlistenDone();
      if (unlistenError) unlistenError();
    };
  }, []);

  async function sendMessage() {
    
    if (isThinking) {
      await invoke("python_runtime_start");
      await invoke<{ generationId: string }>("chat_cancel", {
        generationId: activeGenerationId
      });
      setIsThinking(false);
      setActiveGenerationId(null);
      activeAssistantMessageIdRef.current = null;
      return;
    }
    const text = draft.trim();

    if (!text) {
      return;
    }

    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setDraft("");
    setIsThinking(true);

    const assistantId = createId();
    activeAssistantMessageIdRef.current = assistantId;

    setMessages((prev) => [
      ...prev,
      {
        id: assistantId,
        role: "assistant",
        selectedModel: selectedModel,
        content: "",
        createdAt: Date.now(),
      },
    ]);

    try {
      await invoke("python_runtime_start");
      const started = await invoke<{ generation_id: string }>("chat_generate", {
        payload: {
          model: selectedModel?.huggingfaceId ?? selectedModelId,
          prompt: text,
          max_new_tokens: 1024,
          temperature: 0.6,
        },
      });
      setActiveGenerationId(started.generation_id);
    } catch (e) {
      setIsThinking(false);
      setActiveGenerationId(null);
      activeAssistantMessageIdRef.current = null;
      setMessages((prev) => [
        ...prev,
        {
          id: createId(),
          role: "assistant",
          selectedModel: selectedModel,
          content: `Error: ${String(e)}`,
          createdAt: Date.now(),
        },
      ]);
    }
  }

  return (
    <div className="h-full flex flex-col shrink-0 w-full transition-transform ease-in-out duration-300">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-gray-400/30 border border-gray-400 shadow-lg">
            <span className="text-[11px] text-white/60">Model</span>
            <span className="text-[11px] font-semibold text-white/90">
              {selectedModel?.id ?? "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto rounded-2xl bg-gray-400/20 cerebro-scrollbar"
      >
        <div className="p-2 space-y-3">
          {messages.length === 0 ? (
            <div className="text-sm text-white/70">No messages yet.</div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className={`flex ${
                  m.role === "user" ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-tr-md bg-black/50 text-white border border-gray-400 px-3 pt-1 pb-2"
                      : "max-w-[85%] rounded-2xl rounded-tl-md bg-white/20 text-white border border-gray-400 px-3 pt-1 pb-2"
                  }
                >
                  <div className="text-[10px] uppercase tracking-wider opacity-80">
                    {m.role === "user" ? "You" : m.selectedModel?.id ?? "AI"}
                  </div>
                  <div className="tracking-tight text-sm text-white">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {m.content}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))
          )}

          {isThinking ? (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-md bg-white/30 text-white border border-gray-400 px-4 py-3">
                <div className="text-[11px] uppercase tracking-wider opacity-60 mb-1">
                  AI
                </div>
                <div className="text-sm text-white/70">Thinking...</div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Composer */}
      <div className="mt-3">
        <div className="rounded-2xl bg-gray-400/20 overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-1 bg-gray-400/30 border-b border-gray-400">
            <label className="text-[11px] font-semibold text-white/80">
              Model
            </label>
            <select
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              className="flex-1 min-w-0 text-xs rounded-xl bg-white/30 text-white px-3 py-2 shadow-lg border border-gray-400 focus:outline-none"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-end gap-1.5 p-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              rows={3}
              placeholder="Write your message here... (Enter to send, Shift+Enter to break line)"
              className="flex-1 resize-none rounded-2xl bg-white/20 px-4 py-3 text-xs text-white border border-gray-400 focus:outline-none"
            />

            <button
              type="button"
              onClick={sendMessage}
              disabled={!isThinking && !draft.trim()}
              className={
                "shrink-0 rounded-2xl px-4 py-3 text-sm font-semibold transition-all shadow-xl " +
                (!isThinking && !draft.trim()
                  ? "bg-gray-400/30 text-white/50 cursor-not-allowed"
                  : "bg-white text-black hover:bg-gray-100/80")
              }
            >
              {isThinking ? "Cancel" : "Send"}
            </button>
          </div>
        </div>

        <p className="my-2 text-center text-[9px] text-white/50 leading-tight">
          The first message will take longer since the model needs to be loaded. Contribute to this open-source project on{" "}
          <a
            target="_blank"
            className="underline"
            href="https://github.com/lucasmengarda/Cerebro"
          >
            GitHub
          </a>
          .
        </p>
      </div>
    </div>
  );
}

export default Chat;
