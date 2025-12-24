import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";

type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

type ApiHistoryEntry = {
  id: string;
  createdAt: number;
  method: HttpMethod;
  baseUrl: string;
  path: string;
  headersJson: string;
  bodyJson: string;
};

type ApiResponseState = {
  ok: boolean;
  status: number;
  statusText: string;
  elapsedMs: number;
  bodyText: string;
  error?: string;
} | null;

type BackendHttpResponse = {
  status: number;
  status_text: string;
  body_text: string;
};

const STORAGE_KEY = "com.genoalabs.cerebro.apiClient.history.v1";
const HISTORY_LIMIT = 50;

function createId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeUrl(baseUrl: string, path: string) {
  const base = baseUrl.trim().replace(/\/$/, "");
  const p = path.trim();
  if (!p) return base;
  if (p.startsWith("/")) return `${base}${p}`;
  return `${base}/${p}`;
}

function safeParseJsonObject(text: string): {
  value: Record<string, string>;
  error?: string;
} {
  const t = text.trim();
  if (!t) return { value: {} };
  try {
    const parsed = JSON.parse(t);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: {}, error: "Headers must be a JSON object" };
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
      else out[k] = JSON.stringify(v);
    }
    return { value: out };
  } catch {
    return { value: {}, error: "Invalid headers JSON" };
  }
}

function APIClient() {
  const methods: HttpMethod[] = [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "HEAD",
    "OPTIONS",
  ];

  const [method, setMethod] = useState<HttpMethod>("GET");
  const [baseUrl, setBaseUrl] = useState("http://localhost:3000");
  const [path, setPath] = useState("");
  const [headersJson, setHeadersJson] = useState(
    '{\n  "Content-Type": "application/json"\n}'
  );
  const [bodyJson, setBodyJson] = useState("{}\n");

  const [history, setHistory] = useState<ApiHistoryEntry[]>([]);
  const [response, setResponse] = useState<ApiResponseState>(null);
  const [isSending, setIsSending] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setHistory(parsed.slice(0, HISTORY_LIMIT));
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(history.slice(0, HISTORY_LIMIT))
      );
    } catch {
      // ignore
    }
  }, [history]);

  const fullUrl = normalizeUrl(baseUrl, path);
  const canHaveBody = method !== "GET" && method !== "HEAD";

  async function runRequest(entryOverride?: Partial<ApiHistoryEntry>) {
    if (isSending) return;

    const nextMethod = (entryOverride?.method as HttpMethod) ?? method;
    const nextBaseUrl = entryOverride?.baseUrl ?? baseUrl;
    const nextPath = entryOverride?.path ?? path;
    const nextHeadersJson = entryOverride?.headersJson ?? headersJson;
    const nextBodyJson = entryOverride?.bodyJson ?? bodyJson;
    const nextUrl = normalizeUrl(nextBaseUrl, nextPath);

    if (!nextBaseUrl.trim()) {
      setValidationError("Base URL is required (e.g. https://api.example.com)");
      return;
    }

    const headersParsed = safeParseJsonObject(nextHeadersJson);
    if (headersParsed.error) {
      setValidationError(headersParsed.error);
      return;
    }

    let body: string | undefined;
    if (nextMethod !== "GET" && nextMethod !== "HEAD") {
      const t = nextBodyJson.trim();
      if (t) {
        try {
          JSON.parse(t);
          body = t;
        } catch {
          setValidationError("Invalid JSON body");
          return;
        }
      }
    }

    setValidationError(null);
    setIsSending(true);
    setResponse(null);

    const started = performance.now();
    try {
      const res = await invoke<BackendHttpResponse>("http_request", {
        request: {
          method: nextMethod,
          url: nextUrl,
          headers: headersParsed.value,
          body,
        },
      });
      const elapsedMs = Math.round(performance.now() - started);

      setResponse({
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: res.status_text,
        elapsedMs,
        bodyText: res.body_text,
      });

      const newEntry: ApiHistoryEntry = {
        id: createId(),
        createdAt: Date.now(),
        method: nextMethod,
        baseUrl: nextBaseUrl,
        path: nextPath,
        headersJson: nextHeadersJson,
        bodyJson: nextBodyJson,
      };
      setHistory((prev) => [newEntry, ...prev].slice(0, HISTORY_LIMIT));
    } catch (e) {
      const elapsedMs = Math.round(performance.now() - started);
      setResponse({
        ok: false,
        status: 0,
        statusText: "",
        elapsedMs,
        bodyText: "",
        error: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setIsSending(false);
    }
  }

  function loadFromHistory(entry: ApiHistoryEntry) {
    setMethod(entry.method);
    setBaseUrl(entry.baseUrl);
    setPath(entry.path);
    setHeadersJson(entry.headersJson);
    setBodyJson(entry.bodyJson);
    runRequest(entry);
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="min-w-0"></div>

        <button
          type="button"
          onClick={() => {
            setHistory([]);
            setResponse(null);
            setMethod("GET");
            setPath("");
            setHeadersJson('{\n  "Content-Type": "application/json"\n}');
            setBodyJson("{}");
            setValidationError(null);
          }}
          className="rounded-full bg-black/70 border border-gray-400 px-3 py-1 text-[11px] text-white/80 shadow-lg hover:bg-gray-500/80"
        >
          Clear
        </button>
      </div>

      <div className="h-fit cerebro-scrollbar overflow-y-auto pe-2">
        {/* Request */}
        <div className="rounded-2xl bg-gray-400/30 border border-gray-400 shadow-2xl overflow-hidden">
          <div className="p-3 space-y-2">
            <div className="flex items-center gap-2">
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as HttpMethod)}
                className="w-27.5 text-xs rounded-xl bg-white/30 text-white px-3 py-2 shadow-lg border border-gray-400 focus:outline-none"
              >
                {methods.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>

              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com"
                className="flex-1 min-w-0 text-xs rounded-xl bg-white/30 text-white placeholder:text-white/40 px-3 py-2 shadow-lg border border-gray-400 focus:outline-none"
              />
            </div>

            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="eg.: v1/users"
              className="w-full text-xs rounded-xl bg-white/30 text-white placeholder:text-white/40 px-3 py-2 shadow-lg border border-gray-400 focus:outline-none"
            />

            <div className="text-[11px] text-white/60 px-1">
              URL: <span className="text-white/80">{fullUrl}</span>
            </div>

            <details className="rounded-xl bg-black/70 border border-gray-400">
              <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-white/80 hover:bg-gray-500/80 rounded-xl">
                Headers (JSON)
              </summary>

              <div
                className={
                  "py-2 px-1 mx-1 mb-1 rounded-xl border border-gray-400 shadow-inner overflow-hidden " +
                  "bg-white/30"
                }
              >
                <Editor
                  height="180px"
                  value={headersJson}
                  theme="vs-dark"
                  className="rounded-xl overflow-hidden"
                  onChange={(value) => {
                    setHeadersJson(value || "");
                  }}
                  defaultLanguage="json"
                  options={{
                    minimap: { enabled: false },
                    fontSize: 11,
                    lineNumbers: "off",
                    glyphMargin: false,
                    folding: true,
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    formatOnPaste: true,
                    formatOnType: true,
                    renderLineHighlight: "none",
                    overviewRulerBorder: false,
                    scrollbar: {
                      vertical: "auto",
                      horizontal: "hidden",
                      alwaysConsumeMouseWheel: false,
                    },
                    padding: { top: 10, bottom: 10 },
                  }}
                />
              </div>

            </details>

            <details
              open={canHaveBody}
              className="bg-black/70 border border-gray-400 rounded-xl"
            >
              <summary className="cursor-pointer select-none px-3 py-2 text-[11px] font-semibold text-white/80 hover:bg-gray-500/80 rounded-xl">
                Body (JSON)
              </summary>
              <div
                className={
                  "py-2 px-1 mx-1 mb-1 rounded-xl border border-gray-400 shadow-inner overflow-hidden " +
                  (canHaveBody ? "bg-white/30" : "bg-gray-400/30 opacity-80")
                }
              >
                <Editor
                  height="180px"
                  value={bodyJson}
                  theme="vs-dark"
                  className="rounded-xl overflow-hidden"
                  onChange={(value) => {
                    setBodyJson(value || "");
                  }}
                  defaultLanguage="json"
                  options={{
                    readOnly: !canHaveBody,
                    domReadOnly: !canHaveBody,
                    minimap: { enabled: false },
                    fontSize: 11,
                    lineNumbers: "off",
                    glyphMargin: false,
                    folding: true,
                    scrollBeyondLastLine: false,
                    wordWrap: "on",
                    formatOnPaste: true,
                    formatOnType: true,
                    renderLineHighlight: "none",
                    overviewRulerBorder: false,
                    scrollbar: {
                      vertical: "auto",
                      horizontal: "hidden",
                      alwaysConsumeMouseWheel: false,
                    },
                    padding: { top: 10, bottom: 10 },
                  }}
                />
              </div>
            </details>

            {validationError ? (
              <div className="rounded-xl bg-black/70 border border-gray-400 px-3 py-2 text-xs text-white/80 shadow-lg">
                {validationError}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => runRequest()}
              disabled={isSending}
              className={
                "w-full rounded-2xl px-4 py-3 text-sm font-semibold transition-all shadow-xl border border-gray-400 " +
                (isSending
                  ? "bg-gray-400/30 text-white/50 cursor-not-allowed"
                  : "bg-white/30 text-white hover:bg-gray-400/80 hover:shadow-2xl")
              }
            >
              {isSending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>

        {/* Response + History */}
        <div className="mt-3 flex-1 overflow-hidden grid grid-rows-[auto_1fr] gap-3">
          <div className="rounded-2xl bg-gray-400/30 border border-gray-400 shadow-2xl overflow-hidden">
            <div className="px-3 py-2 bg-gray-400/30 border-b border-gray-400 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-white/80">
                Response
              </span>
              {response ? (
                <span className="text-[11px] text-white/70">
                  {response.status ? `HTTP ${response.status}` : "Failed"} •{" "}
                  {response.elapsedMs}ms
                </span>
              ) : (
                <span className="text-[11px] text-white/50">—</span>
              )}
            </div>
            <div className="p-3">
              {response ? (
                response.error ? (
                  <div className="text-xs text-white/80">{response.error}</div>
                ) : (
                  <pre className="max-h-35 overflow-auto whitespace-pre-wrap wrap-break-word font-sans text-xs text-white/80">
                    {response.bodyText || "(empty body)"}
                  </pre>
                )
              ) : (
                <div className="text-xs text-white/60">
                  Send a request to see the response here.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl bg-gray-400/30 border border-gray-400 shadow-2xl overflow-hidden">
            <div className="px-3 py-2 bg-gray-400/30 border-b border-gray-400 flex items-center justify-between">
              <span className="text-[11px] font-semibold text-white/80">
                History
              </span>
              <span className="text-[11px] text-white/60">
                {history.length}/50
              </span>
            </div>
            <div className="p-2 h-full overflow-auto">
              {history.length === 0 ? (
                <div className="px-2 py-2 text-xs text-white/60">
                  No requests yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {history.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => loadFromHistory(h)}
                      className="w-full text-left rounded-xl bg-black/70 border border-gray-400 shadow-xl px-3 py-2 hover:bg-gray-500/80"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-white/90">
                          {h.method}
                        </span>
                        <span className="text-[11px] text-white/60 truncate">
                          {new Date(h.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-white/80 truncate">
                        {normalizeUrl(h.baseUrl, h.path)}
                      </div>
                      <div className="mt-1 text-[11px] text-white/50">
                        Click to load and run again
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default APIClient;
