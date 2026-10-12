// Layout invariants every view must keep. Used by the layout spec and by the screenshot spec.
import { expect } from "@playwright/test";

export const horizontalOverflow = (page) =>
  page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, bodyScroll: document.body.scrollWidth }));

export async function expectNoHorizontalScroll(page) {
  const m = await horizontalOverflow(page);
  expect(m.scrollWidth, `document scrollWidth ${m.scrollWidth} vs innerWidth ${m.innerWidth}`).toBeLessThanOrEqual(m.innerWidth);
}

/** Visible controls (button, a, select, input, [role=button], canvas with tabindex excluded) smaller than min x min CSS px.
 *  Inline text links inside prose are exempt (WCAG 2.5.8 inline exception); links of the nav and the header count. */
export function smallTargets(page, min = 40, { scope = "body" } = {}) {
  return page.evaluate(
    ([min, scope]) => {
      const out = [];
      const root = document.querySelector(scope);
      const sel = "button, select, input:not([type=hidden]), [role=button], summary, nav a, header a, .bar a";
      for (const el of root.querySelectorAll(sel)) {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        if (el.closest("[hidden], dialog:not([open])")) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (r.width < min - 0.5 || r.height < min - 0.5) {
          const label = (el.getAttribute("aria-label") || el.textContent || el.id || el.type || "").trim().slice(0, 30);
          out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${label}" ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      }
      return out;
    },
    [min, scope],
  );
}

/** Elements whose text is clipped: overflow hidden/clip with scrollWidth > clientWidth (single line) or a
 *  text node box that sticks out of its parent's box. Scroll containers (auto, scroll) are fine. */
export function clippedText(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.body.querySelectorAll("*")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (!/(hidden|clip)/.test(cs.overflowX + cs.overflowY)) continue;
      if (!el.textContent.trim() || el.closest("dialog:not([open])")) continue;
      if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
        out.push(`${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${el.className} ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
      }
    }
    return out;
  });
}

/** Visible elements with text that stick out of the viewport on the right or left. */
export function textOutsideViewport(page) {
  return page.evaluate(() => {
    const out = [];
    const vw = window.innerWidth;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue;
      const el = n.parentElement;
      if (!el || el.closest("script, style, dialog:not([open]), [hidden]")) continue;
      if (getComputedStyle(el).visibility === "hidden") continue;
      // text inside a scroll container may legitimately be off screen
      let scrolls = false;
      for (let p = el; p && p !== document.body; p = p.parentElement) if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) scrolls = true;
      if (scrolls) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) {
        if (r.width && (r.right > vw + 1 || r.left < -1)) out.push(`${el.tagName.toLowerCase()} "${n.textContent.trim().slice(0, 24)}" ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
      }
    }
    return out;
  });
}

/** WCAG contrast of the computed text colour against the first opaque background up the tree, for the elements
 *  matching `selector`. Returns [{what, ratio}] for each visible match. */
export function contrastOf(page, selector) {
  return page.evaluate((selector) => {
    const parse = (c) => {
      const m = c.match(/[\d.]+/g).map(Number);
      return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 };
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bgOf = (el) => {
      for (let e = el; e; e = e.parentElement) {
        const c = parse(getComputedStyle(e).backgroundColor);
        if (c.a > 0.95) return c;
      }
      return parse(getComputedStyle(document.documentElement).backgroundColor);
    };
    const out = [];
    for (const el of document.querySelectorAll(selector)) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || !el.getBoundingClientRect().width) continue;
      if (!el.textContent.trim()) continue;
      const fg = parse(cs.color);
      const bg = bgOf(el);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      out.push({ what: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""} "${el.textContent.trim().slice(0, 20)}"`, ratio: (a + 0.05) / (b + 0.05) });
    }
    return out;
  }, selector);
}

/** Running CSS animations and transitions (document.getAnimations). */
export const runningAnimations = (page) =>
  page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => a.animationName || a.transitionProperty || a.id || "?"));
