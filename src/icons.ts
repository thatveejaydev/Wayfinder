// Lucide (https://lucide.dev, ISC license), keyed by canonical id so the picker lists
// each icon once rather than once per legacy alias. See the plugin in vite.config.ts.
import lucideIcons from "virtual:lucide-icons";

type IconNode = (typeof lucideIcons)[string];

const iconNodes = new Map<string, IconNode>(Object.entries(lucideIcons));

/** Every Lucide icon id, sorted alphabetically. */
export const iconIds = Array.from(iconNodes.keys()).sort();

export function isIconId(value: string | null | undefined): value is string {
  return Boolean(value && iconNodes.has(value));
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Returns an inline SVG for a Lucide icon id, or an empty string when the id is unknown. */
export function iconSvg(id: string, className = "lucide-icon", strokeWidth = 2): string {
  const node = iconNodes.get(id);
  if (!node) return "";
  const children = node.map(([tag, attrs]) => {
    const attributes = Object.entries(attrs)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}="${escapeAttribute(String(value))}"`)
      .join(" ");
    return `<${tag} ${attributes}/>`;
  }).join("");
  return `<svg class="${className}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${children}</svg>`;
}

/**
 * Shows a saved icon value in `element`. Lucide ids render as SVG; anything else is an
 * emoji saved by an earlier version and is shown as text.
 */
export function showIcon(element: HTMLElement, value: string | null | undefined, className?: string) {
  const svg = value ? iconSvg(value, className) : "";
  element.classList.toggle("legacy-emoji", !svg && Boolean(value));
  if (svg) element.innerHTML = svg;
  else element.textContent = value ?? "";
}

const suggestedIcons = [
  "folder", "folder-open", "layers", "layout-grid", "briefcase", "house", "star", "heart",
  "bookmark", "code", "terminal", "git-branch", "database", "server", "cloud", "globe",
  "link", "mail", "message-circle", "phone", "calendar", "clock", "bell", "users",
  "user", "settings", "wrench", "hammer", "palette", "brush", "pen-tool", "image",
  "camera", "music", "video", "clapperboard", "gamepad-2", "book-open", "graduation-cap", "notebook-pen",
  "file-text", "clipboard", "archive", "box", "package", "shopping-cart", "wallet", "chart-line",
  "download", "upload", "lock", "key-round", "shield", "zap", "rocket", "sparkles",
  "flame", "leaf", "coffee", "sun", "moon", "plane", "car", "map-pin",
].filter(isIconId);

const MAX_RESULTS = 120;

export function iconPickerField(id: string, label: string) {
  return `
    <span class="icon-picker-label" id="${id}-label">${label} <small class="tile-name-hint">(Optional)</small></span>
    <div class="icon-picker" role="group" aria-labelledby="${id}-label">
      <input id="${id}" name="value" type="hidden" />
      <div class="icon-picker-current">
        <span class="icon-picker-preview" aria-hidden="true"></span>
        <span class="icon-picker-name"></span>
        <button class="tile-browse icon-picker-clear" type="button">Clear</button>
      </div>
      <input class="icon-picker-search" type="search" autocomplete="off" spellcheck="false" placeholder="Search ${Math.floor(iconIds.length / 100) * 100}+ icons" aria-label="Search icons" />
      <div class="icon-picker-grid" role="group" aria-label="Icons"></div>
      <p class="icon-picker-status" aria-live="polite"></p>
    </div>`;
}

/** Wires up a field made by `iconPickerField`. The hidden input holds the chosen id and fires `input` on change. */
export function bindIconPicker(container: HTMLElement) {
  const value = container.querySelector<HTMLInputElement>('.icon-picker input[type="hidden"]')!;
  const preview = container.querySelector<HTMLElement>(".icon-picker-preview")!;
  const name = container.querySelector<HTMLElement>(".icon-picker-name")!;
  const clear = container.querySelector<HTMLButtonElement>(".icon-picker-clear")!;
  const search = container.querySelector<HTMLInputElement>(".icon-picker-search")!;
  const grid = container.querySelector<HTMLElement>(".icon-picker-grid")!;
  const status = container.querySelector<HTMLElement>(".icon-picker-status")!;

  const renderCurrent = () => {
    showIcon(preview, value.value);
    name.textContent = !value.value ? "No icon" : isIconId(value.value) ? value.value : "Emoji from an earlier version";
    clear.disabled = !value.value;
    grid.querySelectorAll<HTMLButtonElement>("[data-icon]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.icon === value.value));
    });
  };

  const renderGrid = () => {
    const terms = search.value.trim().toLowerCase().split(/[\s-]+/).filter(Boolean);
    let matches: string[];
    if (!terms.length) {
      matches = suggestedIcons;
      status.textContent = "Suggested icons. Search to see all of them.";
    } else {
      const found = iconIds.filter((id) => terms.every((term) => id.includes(term)));
      const first = terms[0];
      found.sort((a, b) => Number(!a.startsWith(first)) - Number(!b.startsWith(first)));
      matches = found.slice(0, MAX_RESULTS);
      status.textContent = !found.length ? "No icons match."
        : found.length > MAX_RESULTS ? `Showing ${MAX_RESULTS} of ${found.length} matches. Keep typing to narrow them down.`
        : `${found.length} ${found.length === 1 ? "match" : "matches"}`;
    }
    grid.innerHTML = matches.map((id) =>
      `<button class="icon-picker-option" type="button" data-icon="${id}" title="${id}" aria-label="${id}" aria-pressed="false">${iconSvg(id)}</button>`).join("");
    renderCurrent();
  };

  const choose = (next: string) => {
    if (value.value === next) return;
    value.value = next;
    renderCurrent();
    value.dispatchEvent(new Event("input"));
  };

  grid.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("[data-icon]");
    if (button) choose(button.dataset.icon!);
  });
  clear.addEventListener("click", () => choose(""));
  search.addEventListener("input", renderGrid);
  // Keep Enter in the search box from submitting the surrounding form.
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      grid.querySelector<HTMLButtonElement>("[data-icon]")?.focus();
    }
  });
  // Values set from code (for example when a form loads a saved tile) dispatch `input` too.
  value.addEventListener("input", renderCurrent);
  renderGrid();
  return value;
}
