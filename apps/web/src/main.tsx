import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
// Both modules apply the stored preference on import, before React mounts, so
// the first paint is already wearing the user's theme and type scale rather
// than flashing the stock light palette on its way there.
import "./theme/useTheme"
import "./theme/appearance"
import "./index.css"

const container = document.getElementById("root")
if (!container) throw new Error("Observer UI root element is missing")

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
