// Pure DOM helpers -- no app state, no network. Every panel module
// depends on these two.

export const $ = (sel, el = document) => el.querySelector(sel);

export const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    // `undefined`/`null` means "omit this attribute" (the convention every
    // caller uses for a false boolean attribute, e.g.
    // `checked: isChecked ? "checked" : undefined`) -- setAttribute
    // coerces its value to a string regardless, so without this guard
    // setAttribute("checked", undefined) sets the literal string
    // "undefined", and since `checked` is an HTML boolean attribute its
    // mere presence checks the box no matter what string it holds. Every
    // checkbox meant to render unchecked (a disabled provider/model) was
    // rendering checked on every load/reload -- including the enable/
    // disable toggle whose flip-flopping visual state, not the PATCH
    // route, was the real cause of an operator's enable click sometimes
    // reading as a disable click.
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) node.appendChild(c);
  return node;
};
