import React from "react";
import ReactDOM from "react-dom/client";
import AppContainer from "./App";
import { BrowserRouter } from "react-router-dom";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {/* Permite o deslocamento das sub-páginas */}
    <BrowserRouter>
      <AppContainer />
    </BrowserRouter>
  </React.StrictMode>,
);
