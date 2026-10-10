import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app.jsx";

import "./styles.css";

createRoot(document.querySelector("#root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
