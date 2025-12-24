// import reactLogo from "./assets/react.svg";
// import { invoke } from "@tauri-apps/api/core";

import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import "./App.css";
import Chat from "./app/Chat";
import APIClient from "./app/APIClient";
import { useEffect, useState } from "react";

function AppContainer() {
  const [activePage, setActivePage] = useState("dashboard");

  const location = useLocation();

  useEffect(() => {
    const path = location.pathname;

    if (path.includes("/apiclient")) {
      setActivePage("apiclient");
    } else {
      setActivePage("chat");
    }
  }, [location]);

  return (
    <main className="container">
      <div className="inline-flex border-b border-gray-500 w-fit mb-2 pb-0.5">
        <span className="pt-1 text-sm">{"</>"}</span>
        <p className="ms-1 text-lg font-bold">
          CERE<span className="font-light">BRO</span>
        </p>
      </div>

      {/* Seletor de tabs */}
      <div className="bg-gray-400/30 rounded-full inline-flex gap-1 p-1 w-fit">
        <BotaoContainer
          nome="Chat"
          rota="/"
          selecionado={activePage === "chat"}
        />
        <BotaoContainer
          nome="API Client"
          rota="/apiclient"
          selecionado={activePage === "apiclient"}
        />
      </div>

      {/* Container Real */}
      <div className="mt-0 flex-1 overflow-auto">
        <Routes>
          <Route path="/" element={<Chat />} />
          <Route path="/apiclient" element={<APIClient />} />
        </Routes>
      </div>
    </main>
  );
}

function BotaoContainer({
  nome,
  rota,
  selecionado = false,
}: {
  nome: string;
  rota: string;
  selecionado?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <button
      className={`rounded-full bg-black/70 px-8 text-xs py-0.5 transition-colors ${
        selecionado
          ? "bg-white/30 font-semibold border-2 border-gray-400 hover:bg-gray-400/80"
          : "font-normal hover:bg-gray-500/80"
      }`}
      onClick={() => navigate(rota)}
    >
      {nome}
    </button>
  );
}

export default AppContainer;
