// Entry point: wires the render callback into state.js (breaking the
// state.js <-> render.js import cycle) and kicks off the initial load.

import { $, el } from "./dom.js";
import { loadState, setOnStateChanged } from "./state.js";
import { render } from "./render.js";

setOnStateChanged(render);

loadState().catch((err) => {
  $("#app").innerHTML = "";
  $("#app").appendChild(el("section", { class: "panel" }, [el("p", { text: "Failed to load: " + err.message })]));
});
