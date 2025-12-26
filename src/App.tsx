// import reactLogo from "./assets/react.svg";
// import { invoke } from "@tauri-apps/api/core";

import "./App.css";
import Chat from "./app/Chat";
import APIClient from "./app/APIClient";
import Models from "./app/Models";
import { useRef, useState } from "react";

function AppContainer() {
  const [activePage, setActivePage] = useState("chat");
  const mainDiv = useRef<HTMLDivElement | null>(null);

  return (
    <main className="container">
      <div className="inline-flex border-b border-gray-500 w-fit mb-2 pb-0.5">
        <span className="pt-1 text-sm">{"</>"}</span>
        <p className="ms-1 text-lg font-bold">
          CERE<span className="font-light">BRO</span>
        </p>
      </div>

      {/* Seletor de Tabs */}
      <div className="bg-gray-400/30 rounded-full inline-flex gap-1 p-1 w-fit transition-all duration-200">
        <BotaoContainer
          nome="Chat"
          selecionado={activePage === "chat"}
          onClick={() => {
            mainDiv.current!.style.transform = "translateX(0%)";
            setActivePage("chat");
            window.dispatchEvent(
              new CustomEvent("lucasmengarda::updateChat", {
                detail: {},
              })
            );
          }}
        />
        <BotaoContainer
          nome="API Client"
          selecionado={activePage === "apiclient"}
          onClick={() => {
            mainDiv.current!.style.transform = "translateX(-100%)";
            setActivePage("apiclient");
            window.dispatchEvent(
              new CustomEvent("lucasmengarda::updateApiclient", {
                detail: {},
              })
            );
          }}
        />
        {"·"}
        <BotaoContainer
          nome="Models"
          selecionado={activePage === "models"}
          onClick={() => {
            mainDiv.current!.style.transform = "translateX(-200%)";
            setActivePage("models");
            window.dispatchEvent(
              new CustomEvent("lucasmengarda::updateModels", {
                detail: {},
              })
            );
          }}
        />
      </div>

      {/* Container Real */}
      <div className="mt-0 flex-1 overflow-hidden">
        <div ref={mainDiv} className="flex h-full w-full transition-transform ease-in-out duration-300">
          <div className="w-full shrink-0">
            <Chat />
          </div>
          <div className="w-full shrink-0">
            <APIClient />
          </div>
          <div className="w-full shrink-0">
            <Models />
          </div>
        </div>
      </div>
    </main>
  );
}

function BotaoContainer({
  nome,
  onClick,
  selecionado = false,
}: {
  nome: string;
  onClick?: () => void;
  selecionado?: boolean;
}) {
  
  return (
    <button
      className={`rounded-full bg-black/70 px-8 text-xs py-0.5 transition-colors ${
        selecionado
          ? "bg-white/30 font-semibold border-2 border-gray-400 hover:bg-gray-400/80"
          : "font-normal hover:bg-gray-500/80"
      }`}
      onClick={onClick}
    >
      {nome}
    </button>
  );
}

export default AppContainer;
