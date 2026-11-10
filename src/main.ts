import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { version as appVersion } from "../src-tauri/tauri.conf.json";
import { indexShortcut, rankShortcutMatches } from "./shortcut_search";
import tailwindColorTokens from "./tailwind_colors.json";
import "./style.css";

type Shortcut = {
  id: string;
  path: string;
  name: string;
  kind: "folder" | "image" | "pdf" | "video" | "audio" | "file" | "submenu" | "text" | "webpage" | "app";
  preview: string | null;
  text?: string | null;
  parentId?: string | null;
  color?: string | null;
};

type TileKind = "submenu" | "text" | "folder" | "webpage" | "app";
type EditableTileKind = TileKind | "file";
// Tailwind CSS 4.3.0 default theme colors, stored by token name in new tiles.
const tailwindColors: Record<string, string> = tailwindColorTokens;
const tailwindColorGroups = new Map<string, string[]>();
for (const token of Object.keys(tailwindColors)) {
  const family = token.split("-")[0];
  if (!tailwindColorGroups.has(family)) tailwindColorGroups.set(family, []);
  tailwindColorGroups.get(family)!.push(token);
}

function tileLabelColor(value?: string | null): string | null {
  if (!value) return null;
  if (Object.hasOwn(tailwindColors, value)) return tailwindColors[value];
  return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

const tileNameHints: Partial<Record<EditableTileKind, string>> = {
  app: "(Leave blank for icon only)",
  text: "(Optional · defaults to the first 12 characters)",
  webpage: "(Leave blank for icon only)",
};
type TileSelection = { item: Omit<Shortcut, "preview">; level: number };
type EditorTab = "tiles" | "edit-tile" | "appearance" | "theme" | "misc" | "about";
type InstalledApp = { name: string; path: string };
const tileDefinitions: { kind: TileKind; label: string; detail: string }[] = [
  { kind: "submenu", label: "Submenu", detail: "Group related shortcuts in a focused view" },
  { kind: "text", label: "Text", detail: "Copy a saved snippet" },
  { kind: "folder", label: "Folder", detail: "Open a directory in File Explorer" },
  { kind: "webpage", label: "Webpage", detail: "Open a saved link" },
  { kind: "app", label: "App", detail: "Launch an app or shortcut" },
];

type ThemeMode = "light" | "dark" | "system";
type ThemeColor = "background" | "highlight" | "border";
type Theme = { mode: ThemeMode } & Record<ThemeColor, string | null>;

const themeColors: { key: ThemeColor; label: string; light: string; dark: string }[] = [
  { key: "background", label: "Palette background", light: "#f0f2f5", dark: "#181818" },
  { key: "highlight", label: "Tile highlight", light: "#90c7fb", dark: "#5ba9f2" },
  { key: "border", label: "Tile border", light: "#a3aeb9", dark: "#3b3b3b" },
];
const themePresets: { id: string; label: string; colors: Record<ThemeColor, string> }[] = [
  { id: "graphite", label: "Graphite", colors: { background: "#181818", highlight: "#d4d4d4", border: "#606060" } },
  { id: "indigo", label: "Indigo Night", colors: { background: "#191b2c", highlight: "#abb5f5", border: "#5a6289" } },
  { id: "forest", label: "Forest", colors: { background: "#182620", highlight: "#9bd9b0", border: "#517968" } },
  { id: "ember", label: "Ember", colors: { background: "#29201c", highlight: "#ffc28a", border: "#8b6351" } },
  { id: "rosewood", label: "Rosewood", colors: { background: "#2b1e27", highlight: "#f0aec8", border: "#875d73" } },
  { id: "porcelain", label: "Porcelain", colors: { background: "#f4f1ea", highlight: "#2a6466", border: "#8d9d96" } },
  { id: "deep-ocean", label: "Deep Ocean", colors: { background: "#14252c", highlight: "#76d8e4", border: "#467782" } },
  { id: "amethyst", label: "Amethyst", colors: { background: "#241b31", highlight: "#d9b7fa", border: "#755b8d" } },
  { id: "sandstone", label: "Sandstone", colors: { background: "#f4ead9", highlight: "#79501f", border: "#b3a18a" } },
  { id: "frost", label: "Frost", colors: { background: "#eaf2f8", highlight: "#315b89", border: "#8a9fb6" } },
];
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

type Appearance = {
  shellSize: number;
  textSize: number;
  innerRadius: number;
  borderThickness: number;
  tileCornerRadius: number;
  tilePadding: number;
  submenuPadding: number;
  colorLabelDistance: number;
  theme: Theme;
  animations: boolean;
  openAtScreenCenter: boolean;
  castShadow: boolean;
};

type AppearanceKey = Exclude<keyof Appearance, "theme" | "animations" | "openAtScreenCenter" | "castShadow">;

const sliderDefinitions: { key: AppearanceKey; label: string; min: number; max: number; group: "Geometry" | "Spacing" }[] = [
  { key: "shellSize", label: "Tile size", min: 360, max: 760, group: "Geometry" },
  { key: "textSize", label: "Text size", min: 8, max: 18, group: "Geometry" },
  { key: "innerRadius", label: "Center opening", min: 60, max: 156, group: "Geometry" },
  { key: "borderThickness", label: "Border thickness", min: 0, max: 6, group: "Geometry" },
  { key: "tileCornerRadius", label: "Tile corner radius", min: 0, max: 30, group: "Geometry" },
  { key: "tilePadding", label: "Tile padding", min: 0, max: 16, group: "Spacing" },
  { key: "submenuPadding", label: "Submenu padding", min: 0, max: 24, group: "Spacing" },
  { key: "colorLabelDistance", label: "Color label distance", min: 0, max: 24, group: "Spacing" },
];

const app = document.querySelector<HTMLDivElement>("#app")!;
const isEditorWindow = new URLSearchParams(window.location.search).get("editor") === "1";
const SVG_NS = "http://www.w3.org/2000/svg";
const CENTER = 310;
const OUTER = 231;
const COLOR_LABEL_STROKE_WIDTH = 6;
const MAX_ITEMS = 12;
const RECENT_SHORTCUTS_KEY = "wayfinder.recent-shortcuts";
const MAX_RECENT_SHORTCUTS = 100;

let shortcuts: Shortcut[] = [];
let searchIndex: { source: Shortcut[]; entries: ReturnType<typeof indexShortcut<Shortcut>>[] } | undefined;
let recentShortcutIds = isEditorWindow ? [] : loadRecentShortcutIds();
const shortcutIcons = new Map<string, Promise<string | null>>();
let editing = false;
let dragging = false;
let externalDragging = false;
let incomingTileKind: TileKind | null = null;
let incomingIndex: number | null = null;
let incomingParentId: string | null = null;
let activeSubmenus: string[] = [];
let focusedSubmenuId: string | null = null;
let searchQuery = "";
let selectedSearchId: string | null = null;
let displayedAngles: [number, number][] = [];
let layoutAnimation = 0;
let displayedChildAngles: [number, number][][] = [[], [], []];
let childLayoutAnimations = [0, 0, 0];
let tileDropHandled = false;
let busy = false;
let toastTimer = 0;
let saveTimer = 0;
let saveQueue = Promise.resolve();
let editorTab: EditorTab = "tiles";
let paletteHotkey: string | null = null;
let savingHotkey = false;
let tileForm: { kind: TileKind; index: number; parentId: string | null } | null = null;
let selectedTileId: string | null = null;
let selectedTile: TileSelection | null = null;
let tileReorder: TileReorder | null = null;
let suppressTileClick = false;
let appearance: Appearance = {
  shellSize: 620,
  textSize: 9,
  innerRadius: 144,
  borderThickness: 2,
  tileCornerRadius: 0,
  tilePadding: 5,
  submenuPadding: 8,
  colorLabelDistance: 7,
  theme: { mode: "dark", background: null, highlight: null, border: null },
  animations: true,
  openAtScreenCenter: true,
  castShadow: false,
};

function applyPreferences() {
  const { theme } = appearance;
  const mode = theme.mode === "system" ? (systemTheme.matches ? "dark" : "light") : theme.mode;
  const root = document.documentElement;
  root.toggleAttribute("data-no-animations", !appearance.animations);
  root.toggleAttribute("data-cast-shadow", appearance.castShadow);
  root.dataset.theme = mode;
  for (const { key, ...defaults } of themeColors) {
    const color = theme[key] ?? defaults[mode];
    root.style.setProperty(`--palette-${key}`, color);
    if (key !== "border") {
      const channels = [1, 3, 5].map((offset) => {
        const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
      root.style.setProperty(`--palette-${key}-text`, luminance > 0.179 ? "#000" : "#fff");
    }
    const input = app.querySelector<HTMLInputElement>(`#theme-${key}`);
    if (input && input.value !== color.toLowerCase()) input.value = color;
    const swatchValue = app.querySelector<HTMLElement>(`[data-theme-value="${key}"]`);
    if (swatchValue) swatchValue.textContent = color.toUpperCase();
  }
  const presetSelect = app.querySelector<HTMLSelectElement>("#theme-preset");
  if (presetSelect) {
    const preset = themePresets.find(({ colors }) => themeColors.every(({ key, ...defaults }) =>
      (theme[key] ?? defaults[mode]).toLowerCase() === colors[key]));
    presetSelect.value = preset?.id ?? "";
  }
  root.toggleAttribute("data-custom-highlight", theme.highlight !== null);
  if (theme.border) root.style.setProperty("--palette-custom-border", theme.border);
  else root.style.removeProperty("--palette-custom-border");
}

systemTheme.addEventListener("change", () => {
  if (appearance.theme.mode === "system") applyPreferences();
});

function icon(kind: Shortcut["kind"]): string {
  switch (kind) {
    case "text":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="7" width="32" height="34" rx="5" fill="#7795c9"/><path d="M15 18h18M15 24h18M15 30h12" stroke="white" stroke-width="3" stroke-linecap="round"/></svg>`;
    case "webpage":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="18" fill="#5d9edb"/><path d="M7 24h34M24 6c-5 5-8 11-8 18s3 13 8 18M24 6c5 5 8 11 8 18s-3 13-8 18" fill="none" stroke="white" stroke-width="2"/></svg>`;
    case "app":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="7" width="36" height="34" rx="6" fill="#7772cc"/><path d="M6 17h36M15 12h1M21 12h1M17 28l5 5 9-11" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    case "folder":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M5 13a4 4 0 0 1 4-4h11l4 4h15a4 4 0 0 1 4 4v4H5z" fill="#efad22"/><path d="M5 20a4 4 0 0 1 4-4h30a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4z" fill="#ffd46a"/></svg>`;
    case "image":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="6" y="8" width="36" height="32" rx="5" fill="#8069b7"/><circle cx="17" cy="18" r="4" fill="#dbc5ff"/><path d="m9 35 11-12 7 7 5-5 8 10" fill="none" stroke="#e7d9ff" stroke-width="3" stroke-linejoin="round"/></svg>`;
    case "pdf":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M12 5h17l8 8v29H12a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z" fill="#f07875"/><path d="M29 5v8h8" fill="#ffc2bf"/><text x="24" y="32" text-anchor="middle" fill="white" font-size="12" font-weight="700">PDF</text></svg>`;
    case "video":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="5" y="9" width="38" height="30" rx="6" fill="#627fe8"/><path d="m20 16 13 8-13 8z" fill="white"/></svg>`;
    case "audio":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="19" fill="#39b9a5"/><path d="M28 12v18a5 5 0 1 1-3-5V16l10-3v14a5 5 0 1 1-3-5V11z" fill="white"/></svg>`;
    default:
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M12 5h16l9 9v27a3 3 0 0 1-3 3H12a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z" fill="#7e9cab"/><path d="M28 5v9h9" fill="#bfd4df"/><path d="M16 24h16M16 30h13" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
}

function point(radius: number, angle: number): [number, number] {
  const radians = angle * Math.PI / 180;
  return [CENTER + Math.cos(radians) * radius, CENTER + Math.sin(radians) * radius];
}

function positionTile(button: HTMLButtonElement, radius: number, angle: number) {
  const [x, y] = point(radius, angle);
  button.style.left = `${x / 620 * 100}%`;
  button.style.top = `${y / 620 * 100}%`;
  button.style.setProperty("--submenu-angle", `${angle}deg`);
}

function positionSegment(segment: SVGGElement, start: number, end: number, inner: number, outer: number) {
  const [hitArea, surface, accent] = segment.children;
  const paths = ringSegmentPaths(start, end, inner, outer, Boolean(accent));
  hitArea.setAttribute("d", paths.tile);
  surface.setAttribute("d", paths.tile);
  accent?.setAttribute("d", paths.accent);
  segment.style.setProperty("--submenu-angle", `${(start + end) / 2}deg`);
}

function loadShortcutIcon(item: Shortcut, container: HTMLElement) {
  let source = shortcutIcons.get(item.id);
  if (!source) {
    source = invoke<string | null>("shortcut_icon", { id: item.id }).catch(() => null);
    shortcutIcons.set(item.id, source);
  }
  void source.then((url) => {
    if (!url || !container.isConnected) return;
    const image = new Image();
    image.alt = "";
    image.className = "shortcut-image";
    image.onload = () => container.replaceChildren(image);
    image.src = url;
  });
}

function childrenOf(parentId: string | null): Shortcut[] {
  return shortcuts.filter((item) => (item.parentId ?? null) === parentId);
}

function shortcutName(item: Pick<Shortcut, "kind" | "name" | "path" | "text">): string {
  if (item.kind === "text" && !item.name) {
    return Array.from(item.text?.trimStart() ?? "").slice(0, 12).join("").trimEnd() || "Whitespace";
  }
  if (item.kind === "webpage" && !item.name) {
    try {
      return new URL(item.path).hostname || "Webpage";
    } catch {
      return "Webpage";
    }
  }
  return item.name || item.path.split(/[\\/]/).pop()?.replace(/\.(exe|lnk)$/i, "") || "App";
}

function searchMatches(query: string): Shortcut[] {
  if (searchIndex?.source !== shortcuts) {
    const byId = new Map(shortcuts.map((item) => [item.id, item]));
    searchIndex = {
      source: shortcuts,
      entries: shortcuts.map((item) => indexShortcut(item, shortcutName(item), shortcutParents(item, (id) => byId.get(id)))),
    };
  }
  return rankShortcutMatches(searchIndex.entries, query, recentShortcutIds);
}

function shortcutParents(item: Shortcut, findParent: (id: string) => Shortcut | undefined): string[] {
  const parents: string[] = [];
  const visited = new Set([item.id]);
  let parentId = item.parentId;
  while (parentId && !visited.has(parentId)) {
    const parent = findParent(parentId);
    if (!parent) break;
    parents.unshift(shortcutName(parent));
    visited.add(parentId);
    parentId = parent.parentId;
  }
  return parents;
}

function shortcutBreadcrumb(item: Shortcut): string {
  return shortcutParents(item, (id) => shortcuts.find((candidate) => candidate.id === id)).join(" › ") || "Main palette";
}

function loadRecentShortcutIds(): string[] {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(RECENT_SHORTCUTS_KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return Array.from(new Set(saved.filter((id): id is string => typeof id === "string"))).slice(0, MAX_RECENT_SHORTCUTS);
  } catch {
    return [];
  }
}

function rememberShortcut(id: string) {
  if (recentShortcutIds[0] === id) return;
  recentShortcutIds = [id, ...recentShortcutIds.filter((recentId) => recentId !== id)].slice(0, MAX_RECENT_SHORTCUTS);
  try {
    window.localStorage.setItem(RECENT_SHORTCUTS_KEY, JSON.stringify(recentShortcutIds));
  } catch {
    // The current session still has its recent shortcuts if storage is unavailable.
  }
}

function resetPaletteSearch() {
  searchQuery = "";
  selectedSearchId = null;
}

function bindPaletteSearch(field: HTMLInputElement) {
  field.addEventListener("input", () => {
    searchQuery = field.value;
    render("search");
  });
  field.addEventListener("keydown", (event) => {
    if (event.isComposing || !searchQuery.trim()) return;
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!step && event.key !== "Enter") return;
    event.preventDefault();
    const matches = searchMatches(searchQuery);
    if (!matches.length) return;
    const index = Math.max(0, matches.findIndex((item) => item.id === selectedSearchId));
    if (step) {
      selectedSearchId = matches[(index + step + matches.length) % matches.length].id;
      render("search");
    } else {
      void activate(matches[index], 0, event.shiftKey);
    }
  });
}

function submenuRadii(): { inner: number; outer: number }[] {
  const rootDepth = OUTER - appearance.innerRadius;
  const firstInner = OUTER + appearance.submenuPadding;
  const firstOuter = firstInner + rootDepth * 0.9;
  const secondInner = firstOuter + appearance.submenuPadding;
  return [
    { inner: firstInner, outer: firstOuter },
    { inner: secondInner, outer: secondInner + rootDepth },
  ];
}

function roundedAccentEnd(arc: [number, number], corner: [number, number], side: [number, number], scale: number) {
  // Use the half of the corner nearest the outer arc, leaving the tile's side clear.
  const expand = (value: number) => CENTER + (value - CENTER) * scale;
  const control = arc.map((value, index) => expand((value + corner[index]) / 2));
  const end = arc.map((value, index) => expand((value + 2 * corner[index] + side[index]) / 4));
  return { control: control.join(" "), end: end.join(" ") };
}

function ringSegmentPaths(start: number, end: number, innerRadius: number, outerRadius: number, withAccent: boolean) {
  const outerGap = appearance.tilePadding / outerRadius * 180 / Math.PI;
  const innerGap = appearance.tilePadding / innerRadius * 180 / Math.PI;
  const outerStart = start + outerGap;
  const outerEnd = end - outerGap;
  const innerStart = start + innerGap;
  const innerEnd = end - innerGap;
  const [ox1, oy1] = point(outerRadius, outerStart);
  const [oxm, oym] = point(outerRadius, (outerStart + outerEnd) / 2);
  const [ox2, oy2] = point(outerRadius, outerEnd);
  const [ix2, iy2] = point(innerRadius, innerEnd);
  const [ixm, iym] = point(innerRadius, (innerStart + innerEnd) / 2);
  const [ix1, iy1] = point(innerRadius, innerStart);
  const sharpEdge = `M ${ox1} ${oy1} A ${outerRadius} ${outerRadius} 0 0 1 ${oxm} ${oym} A ${outerRadius} ${outerRadius} 0 0 1 ${ox2} ${oy2}`;
  const sharpPath = `${sharpEdge} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 0 0 ${ixm} ${iym} A ${innerRadius} ${innerRadius} 0 0 0 ${ix1} ${iy1} Z`;
  const sideLength = Math.min(Math.hypot(ox1 - ix1, oy1 - iy1), Math.hypot(ox2 - ix2, oy2 - iy2));
  const corner = Math.min(
    appearance.tileCornerRadius,
    sideLength * 0.48,
    (outerEnd - outerStart) * Math.PI / 180 * outerRadius * 0.24,
    (innerEnd - innerStart) * Math.PI / 180 * innerRadius * 0.24,
  );
  const accentRadius = outerRadius + (appearance.borderThickness + COLOR_LABEL_STROKE_WIDTH) / 2 + appearance.colorLabelDistance;
  const accentArc = (to: number) =>
    `A ${accentRadius} ${accentRadius} 0 0 1 ${point(accentRadius, (start + end) / 2).join(" ")} A ${accentRadius} ${accentRadius} 0 0 1 ${point(accentRadius, to).join(" ")}`;
  if (corner <= 0) {
    const inset = (appearance.tilePadding + 3) / accentRadius * 180 / Math.PI;
    const accent = withAccent ? `M ${point(accentRadius, start + inset).join(" ")} ${accentArc(end - inset)}` : "";
    return { tile: sharpPath, accent };
  }
  const outerAngle = corner / outerRadius * 180 / Math.PI;
  const innerAngle = corner / innerRadius * 180 / Math.PI;
  const [outerArcStartX, outerArcStartY] = point(outerRadius, outerStart + outerAngle);
  const [outerArcMiddleX, outerArcMiddleY] = point(outerRadius, (outerStart + outerEnd) / 2);
  const [outerArcEndX, outerArcEndY] = point(outerRadius, outerEnd - outerAngle);
  const roundedEdge = `M ${outerArcStartX} ${outerArcStartY} A ${outerRadius} ${outerRadius} 0 0 1 ${outerArcMiddleX} ${outerArcMiddleY} A ${outerRadius} ${outerRadius} 0 0 1 ${outerArcEndX} ${outerArcEndY}`;
  const [innerArcEndX, innerArcEndY] = point(innerRadius, innerEnd - innerAngle);
  const [innerArcMiddleX, innerArcMiddleY] = point(innerRadius, (innerStart + innerEnd) / 2);
  const [innerArcStartX, innerArcStartY] = point(innerRadius, innerStart + innerAngle);
  const alongSide = (from: [number, number], to: [number, number]): [number, number] => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    return [from[0] + (to[0] - from[0]) * corner / length, from[1] + (to[1] - from[1]) * corner / length];
  };
  const [outerEndSideX, outerEndSideY] = alongSide([ox2, oy2], [ix2, iy2]);
  const [innerEndSideX, innerEndSideY] = alongSide([ix2, iy2], [ox2, oy2]);
  const [innerStartSideX, innerStartSideY] = alongSide([ix1, iy1], [ox1, oy1]);
  const [outerStartSideX, outerStartSideY] = alongSide([ox1, oy1], [ix1, iy1]);
  const tile = `${roundedEdge} Q ${ox2} ${oy2} ${outerEndSideX} ${outerEndSideY} L ${innerEndSideX} ${innerEndSideY} Q ${ix2} ${iy2} ${innerArcEndX} ${innerArcEndY} A ${innerRadius} ${innerRadius} 0 0 0 ${innerArcMiddleX} ${innerArcMiddleY} A ${innerRadius} ${innerRadius} 0 0 0 ${innerArcStartX} ${innerArcStartY} Q ${ix1} ${iy1} ${innerStartSideX} ${innerStartSideY} L ${outerStartSideX} ${outerStartSideY} Q ${ox1} ${oy1} ${outerArcStartX} ${outerArcStartY} Z`;
  if (!withAccent) return { tile, accent: "" };

  const scale = accentRadius / outerRadius;
  const first = roundedAccentEnd([outerArcStartX, outerArcStartY], [ox1, oy1], [outerStartSideX, outerStartSideY], scale);
  const last = roundedAccentEnd([outerArcEndX, outerArcEndY], [ox2, oy2], [outerEndSideX, outerEndSideY], scale);
  const accentStart = point(accentRadius, outerStart + outerAngle).join(" ");
  const accent = `M ${first.end} Q ${first.control} ${accentStart} ${accentArc(outerEnd - outerAngle)} Q ${last.control} ${last.end}`;
  return { tile, accent };
}

function ringSegmentPath(start: number, end: number, innerRadius: number, outerRadius: number): string {
  return ringSegmentPaths(start, end, innerRadius, outerRadius, false).tile;
}

function segmentPath(start: number, end: number): string {
  return ringSegmentPath(start, end, appearance.innerRadius, OUTER);
}

function segmentAngles(index: number, count: number): [number, number, number] {
  if (count === 1) return [-269.9, 89.9, -90];
  const span = 360 / count;
  const start = -90 - span / 2 + index * span;
  return [start, start + span, start + span / 2];
}

function fanSpan(level: number, count: number): number {
  return level === 2 ? count * 17 : Math.min(216, count * 22.5);
}

function fanAngles(level: number, center: number, index: number, count: number): [number, number, number] {
  const span = fanSpan(level, count);
  const width = span / count;
  const start = center - span / 2 + index * width;
  return [start, start + width, start + width / 2];
}

function angleNear(angle: number, center: number): number {
  let near = angle;
  while (near - center > 180) near -= 360;
  while (center - near > 180) near += 360;
  return near;
}

function menuCenter(parentId: string): number | null {
  if (parentId === focusedSubmenuId) return null;
  const roots = childrenOf(focusedSubmenuId);
  const rootIndex = roots.findIndex((item) => item.id === parentId);
  if (rootIndex >= 0) return segmentAngles(rootIndex, roots.length)[2];
  const parent = shortcuts.find((item) => item.id === parentId);
  if (!parent?.parentId) return null;
  const parentCenter = menuCenter(parent.parentId);
  if (parentCenter === null) return null;
  const siblings = childrenOf(parent.parentId);
  const index = siblings.findIndex((item) => item.id === parentId);
  return index >= 0 ? fanAngles(1, parentCenter, index, siblings.length)[2] : null;
}

function openSubmenu(item: Shortcut, level: number) {
  if (level >= 2 || item.kind !== "submenu") return false;
  const next = level === 0 ? [item.id] : [activeSubmenus[0], item.id];
  if (next.join("/") !== activeSubmenus.join("/")) {
    activeSubmenus = next;
    const childLevel = level === 0 ? 1 : 2;
    refreshSubmenus(childLevel, childLevel);
    return true;
  }
  return false;
}

function hoverTile(item: Shortcut, level: number) {
  if (tileReorder || searchQuery.trim()) return;
  if (item.kind === "submenu") {
    openSubmenu(item, level);
  } else if ((!editing || !selectedTileId) && level < activeSubmenus.length) {
    activeSubmenus = activeSubmenus.slice(0, level);
    refreshSubmenus(level === 0 ? 1 : 2);
  }
}

function showToast(message: string, isError = false) {
  const node = document.querySelector<HTMLDivElement>(".toast");
  if (!node) return;
  node.textContent = message;
  node.classList.toggle("error", isError);
  node.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove("visible"), 3200);
}

function palettePosition(clientX: number, clientY: number) {
  const palette = app.querySelector<HTMLElement>(".palette");
  if (!palette) return null;
  const rect = palette.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width * 620 - CENTER;
  const y = (clientY - rect.top) / rect.height * 620 - CENTER;
  return { radius: Math.hypot(x, y), angle: Math.atan2(y, x) * 180 / Math.PI };
}

function insertionIndex(clientX: number, clientY: number): number | null {
  const roots = childrenOf(focusedSubmenuId);
  if (roots.length >= MAX_ITEMS) return null;
  const position = palettePosition(clientX, clientY);
  if (!position) return null;
  const { radius, angle } = position;
  if (radius < appearance.innerRadius - 8 || radius > OUTER + 8) return null;
  const count = roots.length + 1;
  if (count === 1) return 0;
  return ((Math.round((angle + 90) / (360 / count)) % count) + count) % count;
}

type DropTarget = { parentId: string | null; index: number };

function fanInsertionIndex(level: number, center: number, count: number, angle: number): number | null {
  if (count >= MAX_ITEMS) return null;
  const slots = count + 1;
  const span = fanSpan(level, slots);
  const near = angleNear(angle, center);
  if (Math.abs(near - center) > span / 2 + 9) return null;
  const width = span / slots;
  return Math.max(0, Math.min(slots - 1, Math.round((near - (center - span / 2 + width / 2)) / width)));
}

function dropTargetAt(clientX: number, clientY: number, kind: TileKind | null = incomingTileKind): DropTarget | null {
  if (searchQuery.trim()) return null;
  const position = palettePosition(clientX, clientY);
  if (!position) return null;
  const { radius, angle } = position;
  const radii = submenuRadii();

  for (let level = 2; level >= 1; level--) {
    const parentId = activeSubmenus[level - 1];
    if (!parentId) continue;
    const ring = radii[level - 1];
    if (radius < ring.inner - 7 || radius > ring.outer + 7) continue;
    const center = menuCenter(parentId);
    if (center === null) continue;
    const items = childrenOf(parentId);
    const deepest = level === 2 || focusedSubmenuId !== null;
    if (!deepest && items.length) {
      const hovered = items.find((_, index) => {
        const [start, end] = fanAngles(level, center, index, items.length);
        const near = angleNear(angle, center);
        return near >= start && near <= end;
      });
      if (hovered?.kind === "submenu") {
        openSubmenu(hovered, level);
        const children = childrenOf(hovered.id);
        if (kind === "submenu" || children.length >= MAX_ITEMS) return null;
        return { parentId: hovered.id, index: children.length };
      }
    }
    if (deepest && kind === "submenu") return null;
    const index = fanInsertionIndex(level, center, items.length, angle);
    return index === null ? null : { parentId, index };
  }

  if (focusedSubmenuId !== null) {
    const focused = shortcuts.find((item) => item.id === focusedSubmenuId);
    if (kind === "submenu" && focused?.parentId) return null;
    const index = insertionIndex(clientX, clientY);
    return index === null ? null : { parentId: focusedSubmenuId, index };
  }
  if (radius < appearance.innerRadius - 8 || radius > OUTER + 8) return null;
  const roots = childrenOf(null);
  if (roots.length) {
    const rootSpan = 360 / roots.length;
    const hoveredIndex = ((Math.round((angle + 90) / rootSpan) % roots.length) + roots.length) % roots.length;
    const hovered = roots[hoveredIndex];
    if (hovered.kind === "submenu") {
      openSubmenu(hovered, 0);
      const children = childrenOf(hovered.id);
      if (children.length >= MAX_ITEMS) return null;
      return { parentId: hovered.id, index: children.length };
    }
  }
  const index = insertionIndex(clientX, clientY);
  return index === null ? null : { parentId: null, index };
}

function reorderSlot(index: number, from: number, target: number): number {
  if (index === from) return target;
  if (from < index && index <= target) return index - 1;
  if (target <= index && index < from) return index + 1;
  return index;
}

function updateDropIndicator(animate = true) {
  if (searchQuery.trim()) return;
  const placeholder = app.querySelector<SVGPathElement>(".root-drop-indicator");
  if (!placeholder) return;
  const roots = childrenOf(focusedSubmenuId);
  const active = incomingTileKind !== null && incomingParentId === focusedSubmenuId && incomingIndex !== null && roots.length < MAX_ITEMS;
  const reorder = tileReorder?.level === 0 ? tileReorder : null;
  const previewIndex = reorder?.target ?? (active ? incomingIndex : null);
  const count = roots.length + (active ? 1 : 0);
  const target: [number, number][] = roots.map((_, index) => {
    const slot = reorder && reorder.target !== null
      ? reorderSlot(index, reorder.from, reorder.target)
      : index + (active && index >= incomingIndex! ? 1 : 0);
    const [start, end] = segmentAngles(slot, count);
    return [start, end];
  });
  app.querySelector<SVGCircleElement>(".ring-empty")?.style.setProperty("display", active ? "none" : "");
  app.querySelector<HTMLElement>(".empty-prompt")?.style.setProperty("display", active ? "none" : "");
  if (previewIndex !== null) {
    const [start, end] = segmentAngles(previewIndex, count);
    placeholder.setAttribute("d", segmentPath(start, end));
    placeholder.classList.add("visible");
  } else {
    placeholder.classList.remove("visible");
    placeholder.removeAttribute("d");
  }
  const from = animate && displayedAngles.length === target.length ? displayedAngles : target;
  layoutRootTiles(target, from);
}

function layoutRootTiles(target: [number, number][], from: [number, number][]) {
  window.cancelAnimationFrame(layoutAnimation);
  const paths = app.querySelectorAll<SVGGElement>(".ring-segments .segment");
  const buttons = app.querySelectorAll<HTMLButtonElement>('.item-layer .shortcut[data-level="0"]');
  const paint = (angles: [number, number][]) => {
    angles.forEach(([start, end], index) => {
      const middle = (start + end) / 2;
      if (paths[index]) positionSegment(paths[index], start, end, appearance.innerRadius, OUTER);
      if (buttons[index]) positionTile(buttons[index], (OUTER + appearance.innerRadius) / 2, middle);
    });
    displayedAngles = angles;
  };
  if (!appearance.animations || !target.some(([start, end], index) => start !== from[index][0] || end !== from[index][1])) {
    paint(target);
    return;
  }
  paint(from);
  const began = performance.now();
  const tick = (now: number) => {
    const progress = Math.min((now - began) / 150, 1);
    const eased = 1 - (1 - progress) ** 3;
    paint(target.map(([start, end], index) => [
      from[index][0] + (start - from[index][0]) * eased,
      from[index][1] + (end - from[index][1]) * eased,
    ]));
    if (progress < 1) layoutAnimation = window.requestAnimationFrame(tick);
  };
  layoutAnimation = window.requestAnimationFrame(tick);
}

function updateChildDropIndicator(level: 1 | 2, animate = true) {
  const parentId = activeSubmenus[level - 1];
  if (!parentId) return;
  const center = menuCenter(parentId);
  const placeholder = app.querySelector<SVGPathElement>(`.child-drop-indicator[data-level="${level}"]`);
  if (center === null || !placeholder) return;
  const items = childrenOf(parentId);
  const ring = submenuRadii()[level - 1];
  const active = incomingTileKind !== null && incomingParentId === parentId && incomingIndex !== null && items.length < MAX_ITEMS;
  const reorder = tileReorder?.level === level ? tileReorder : null;
  const previewIndex = reorder?.target ?? (active ? incomingIndex : null);
  const count = items.length + (active ? 1 : 0);
  const target: [number, number][] = items.map((_, index) => {
    const slot = reorder && reorder.target !== null
      ? reorderSlot(index, reorder.from, reorder.target)
      : index + (active && index >= incomingIndex! ? 1 : 0);
    const [start, end] = fanAngles(level, center, slot, count);
    return [start, end];
  });
  const paths = Array.from(app.querySelectorAll<SVGGElement>(`.child-segments .segment[data-level="${level}"]`));
  const buttons = Array.from(app.querySelectorAll<HTMLButtonElement>(`.item-layer .shortcut[data-level="${level}"]`));
  const emptySlot = app.querySelector<SVGPathElement>(`.submenu-empty-slot[data-level="${level}"]`);
  if (emptySlot) emptySlot.style.display = active ? "none" : "";
  if (previewIndex !== null) {
    const [start, end] = fanAngles(level, center, previewIndex, count);
    placeholder.setAttribute("d", ringSegmentPath(start, end, ring.inner, ring.outer));
    placeholder.classList.add("visible");
  } else {
    placeholder.classList.remove("visible");
    placeholder.removeAttribute("d");
  }

  window.cancelAnimationFrame(childLayoutAnimations[level]);
  const paint = (angles: [number, number][]) => {
    angles.forEach(([start, end], index) => {
      const middle = (start + end) / 2;
      if (paths[index]) positionSegment(paths[index], start, end, ring.inner, ring.outer);
      if (buttons[index]) positionTile(buttons[index], (ring.inner + ring.outer) / 2, middle);
    });
    displayedChildAngles[level] = angles;
  };
  const from = displayedChildAngles[level].length === target.length
    ? displayedChildAngles[level].map(([start, end]) => [start, end] as [number, number])
    : target;
  if (!appearance.animations || !animate || !target.some(([start, end], index) => start !== from[index][0] || end !== from[index][1])) {
    paint(target);
    return;
  }
  const began = performance.now();
  const tick = (now: number) => {
    const progress = Math.min((now - began) / 150, 1);
    const eased = 1 - (1 - progress) ** 3;
    paint(target.map(([start, end], index) => [
      from[index][0] + (start - from[index][0]) * eased,
      from[index][1] + (end - from[index][1]) * eased,
    ]));
    if (progress < 1) childLayoutAnimations[level] = window.requestAnimationFrame(tick);
  };
  childLayoutAnimations[level] = window.requestAnimationFrame(tick);
}

function previewDropAt(clientX: number, clientY: number) {
  const next = dropTargetAt(clientX, clientY);
  const parentId = next?.parentId ?? null;
  const index = next?.index ?? null;
  if (parentId !== incomingParentId || index !== incomingIndex) {
    incomingParentId = parentId;
    incomingIndex = index;
    updateDropIndicator();
    updateChildDropIndicator(1);
    updateChildDropIndicator(2);
  }
}

function clearDropTarget() {
  incomingIndex = null;
  incomingParentId = null;
  updateDropIndicator();
  updateChildDropIndicator(1);
  updateChildDropIndicator(2);
}

type TileReorder = {
  id: string;
  level: 0 | 1 | 2;
  pointerId: number | null;
  startX: number;
  startY: number;
  started: boolean;
  from: number;
  target: number | null;
  count: number;
  ring: { inner: number; outer: number };
  angles: (index: number) => [number, number, number];
  path: SVGGElement;
  button: HTMLButtonElement;
};

function prepareTileReorder(event: PointerEvent, item: Shortcut, level: TileReorder["level"], path: SVGGElement, button: HTMLButtonElement) {
  if (!editing || busy || incomingTileKind || tileReorder || event.button !== 0 || !event.isPrimary) return;
  if ((event.target as Element).closest(".remove-badge")) return;
  const parentId = item.parentId ?? null;
  const siblings = childrenOf(parentId);
  if (siblings.length < 2) return;
  const center = parentId ? menuCenter(parentId) : 0;
  if (center === null) return;

  tileReorder = {
    id: item.id,
    level,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    started: false,
    from: siblings.findIndex((sibling) => sibling.id === item.id),
    target: null,
    count: siblings.length,
    ring: level === 0 ? { inner: appearance.innerRadius, outer: OUTER } : submenuRadii()[level - 1],
    angles: (index) => level === 0 ? segmentAngles(index, siblings.length) : fanAngles(level, center, index, siblings.length),
    path,
    button,
  };
}

function reorderIndexAt(drag: TileReorder, clientX: number, clientY: number): number | null {
  const position = palettePosition(clientX, clientY);
  if (!position) return null;
  const { radius, angle } = position;
  if (radius < drag.ring.inner - 7 || radius > drag.ring.outer + 7) return null;
  for (let index = 0; index < drag.count; index++) {
    const [start, end, middle] = drag.angles(index);
    const near = angleNear(angle, middle);
    if (near >= start && near <= end) return index;
  }
  return null;
}

function previewTileReorder(event: PointerEvent) {
  const drag = tileReorder;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!(event.buttons & 1)) {
    cancelTileReorder();
    return;
  }
  if (!drag.started) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.started = true;
    suppressTileClick = true;
    app.setPointerCapture(event.pointerId);
    app.dataset.reorderLevel = String(drag.level);
  }
  const index = reorderIndexAt(drag, event.clientX, event.clientY);
  setReorderTarget(drag, index);
}

function updateReorderLayout(level: TileReorder["level"], animate = true) {
  if (level === 0) updateDropIndicator(animate);
  else updateChildDropIndicator(level, animate);
}

function setReorderTarget(drag: TileReorder, index: number | null) {
  if (drag.target === index) return;
  drag.target = index;
  drag.path.classList.toggle("reorder-source", index !== null);
  drag.button.classList.toggle("reorder-source", index !== null);
  updateReorderLayout(drag.level);
}

function cancelTileReorder(restoreLayout = true) {
  const drag = tileReorder;
  if (!drag) return;
  tileReorder = null;
  if (!drag.started) return;
  if (drag.pointerId !== null && app.hasPointerCapture(drag.pointerId)) app.releasePointerCapture(drag.pointerId);
  delete app.dataset.reorderLevel;
  drag.path.classList.remove("reorder-source");
  drag.button.classList.remove("reorder-source");
  if (restoreLayout) updateReorderLayout(drag.level, false);
}

async function finishTileReorder(event: PointerEvent) {
  const drag = tileReorder;
  if (!drag || drag.pointerId !== event.pointerId) return;
  const index = drag.started ? reorderIndexAt(drag, event.clientX, event.clientY) : null;
  if (index === null || index === drag.from) {
    cancelTileReorder();
    return;
  }
  setReorderTarget(drag, index);
  drag.pointerId = null;
  if (app.hasPointerCapture(event.pointerId)) app.releasePointerCapture(event.pointerId);
  busy = true;
  try {
    shortcuts = await invoke<Shortcut[]>("reorder_tile", { id: drag.id, index });
    render();
  } catch (error) {
    cancelTileReorder();
    showToast(String(error), true);
  } finally {
    busy = false;
  }
}

async function finishTileDrop(kind: TileKind, target: DropTarget) {
  if (tileDropHandled) return;
  tileDropHandled = true;
  incomingTileKind = null;
  incomingIndex = null;
  incomingParentId = null;
  render();
  if (busy) return;
  if (childrenOf(target.parentId).length >= MAX_ITEMS) {
    showToast(`This ring is full (${MAX_ITEMS} items)`, true);
    return;
  }
  try {
    await invoke("open_tile_form", { kind, index: target.index, parentId: target.parentId });
  } catch (error) {
    showToast(String(error), true);
  }
}

function appendTile(
  item: Shortcut,
  level: TileReorder["level"],
  start: number,
  end: number,
  middle: number,
  innerRadius: number,
  outerRadius: number,
  segments: SVGGElement,
  layer: HTMLDivElement,
  entrance?: { index: number; count: number },
  searchSelected = false,
) {
  const path = document.createElementNS(SVG_NS, "g");
  const hitArea = document.createElementNS(SVG_NS, "path");
  hitArea.classList.add("segment-hit-area");
  const surface = document.createElementNS(SVG_NS, "path");
  surface.classList.add("segment-surface");
  path.append(hitArea, surface);
  const color = tileLabelColor(item.color);
  if (color) {
    const accent = document.createElementNS(SVG_NS, "path");
    accent.classList.add("segment-accent");
    accent.setAttribute("stroke-width", String(COLOR_LABEL_STROKE_WIDTH));
    path.style.setProperty("--tile-label-color", color);
    path.appendChild(accent);
  }
  positionSegment(path, start, end, innerRadius, outerRadius);
  path.setAttribute("class", "segment");
  path.dataset.level = String(level);
  const searching = Boolean(searchQuery.trim());
  const activeSubmenu = !searching && activeSubmenus.includes(item.id);
  path.classList.toggle("active-submenu", activeSubmenu);
  path.dataset.id = item.id;
  const selected = editing && selectedTileId === item.id;
  path.classList.toggle("selected-tile", selected);
  path.classList.toggle("search-selected", searchSelected);
  path.addEventListener("click", (event) => activate(item, level, event.shiftKey));
  segments.appendChild(path);

  const button = document.createElement("button");
  button.className = `shortcut${level ? ` child-shortcut level-${level}` : ""}`;
  button.classList.toggle("single-content", item.kind === "text" || item.kind === "submenu" || !item.name);
  button.classList.toggle("active-submenu", activeSubmenu);
  button.dataset.id = item.id;
  button.dataset.level = String(level);
  button.type = "button";
  positionTile(button, (innerRadius + outerRadius) / 2, middle);
  const name = shortcutName(item);
  const action = editing ? "Edit" : item.kind === "text" ? "Copy" : "Open";
  const location = searching ? ` · ${shortcutBreadcrumb(item)}` : "";
  button.setAttribute("aria-label", `${action} ${name}${location}`);
  if (searchSelected) button.setAttribute("aria-current", "true");
  if (editing) button.setAttribute("aria-pressed", String(selected));
  button.title = `${action} ${name}${location}`;
  let tileIcon = "";
  if (item.kind === "submenu") {
    const offset = (outerRadius - innerRadius) / 2 - 12;
    button.style.setProperty("--submenu-chevron-offset", String(offset / 620));
    tileIcon = '<svg class="submenu-chevron" viewBox="0 0 8 16" aria-hidden="true"><path d="M0 0 8 8 0 16Z" fill="currentColor"/></svg>';
  } else if (item.kind !== "text") {
    const thumbnail = item.preview
      ? `<img class="shortcut-image" alt="" src="${item.preview}"/>`
      : icon(item.kind);
    tileIcon = `<span class="shortcut-icon ${item.kind}">${thumbnail}</span>`;
  }
  const removeBadge = editing ? `<span class="remove-badge" title="Remove">
    <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
  </span>` : "";
  button.innerHTML = `${tileIcon}${item.name || item.kind === "text" || searching ? '<span class="shortcut-label"></span>' : ""}${removeBadge}`;
  if (!item.preview && (item.kind === "app" || item.kind === "webpage")) {
    loadShortcutIcon(item, button.querySelector<HTMLElement>(".shortcut-icon")!);
  }
  const label = button.querySelector<HTMLElement>(".shortcut-label");
  if (label) label.textContent = name;
  const prepareReorder = (event: PointerEvent) => prepareTileReorder(event, item, level, path, button);
  path.addEventListener("pointerdown", prepareReorder);
  button.addEventListener("pointerdown", prepareReorder);
  button.addEventListener("click", (event) => {
    if (editing && (event.target as Element).closest(".remove-badge")) void removeItem(item);
    else void activate(item, level, event.shiftKey);
  });
  button.addEventListener("pointerenter", () => {
    path.classList.add("hovered");
    hoverTile(item, level);
  });
  button.addEventListener("pointerleave", () => path.classList.remove("hovered"));
  path.addEventListener("pointerenter", () => {
    button.classList.add("hovered");
    hoverTile(item, level);
  });
  path.addEventListener("pointerleave", () => button.classList.remove("hovered"));
  layer.appendChild(button);
  if (entrance) animateTileEntrance(path, button, level, middle, (innerRadius + outerRadius) / 2, entrance);
}

function animateTileEntrance(
  path: SVGGElement,
  button: HTMLButtonElement,
  level: number,
  angle: number,
  radius: number,
  { index, count }: { index: number; count: number },
) {
  const root = level === 0;
  const turn = Math.min(18, 135 / count);
  const [x, y] = point(radius, angle);
  const [fromX, fromY] = root ? point(radius, angle - turn) : point(radius - 12, angle);
  const timing: KeyframeAnimationOptions = {
    duration: root ? 145 : 115,
    delay: index * Math.min(root ? 18 : 10, (root ? 120 : 50) / Math.max(1, count - 1)),
    easing: "cubic-bezier(.2,.75,.25,1)",
    fill: "backwards",
  };
  path.animate([
    { opacity: 0, transform: root ? `rotate(-${turn}deg)` : `translate(${fromX - x}px, ${fromY - y}px)` },
    { opacity: 1, transform: "none" },
  ], timing);
  button.animate([
    { opacity: 0, left: `${fromX / 6.2}%`, top: `${fromY / 6.2}%` },
    { opacity: 1, left: button.style.left, top: button.style.top },
  ], timing);
}

function renderChildRing(parentId: string, level: 1 | 2, segments: SVGGElement, layer: HTMLDivElement, animate: boolean) {
  const center = menuCenter(parentId);
  if (center === null) return;
  const items = childrenOf(parentId);
  const ring = submenuRadii()[level - 1];
  displayedChildAngles[level] = items.map((_, index) => {
    const [start, end] = fanAngles(level, center, index, items.length);
    return [start, end];
  });
  items.forEach((item, index) => {
    const [start, end, middle] = fanAngles(level, center, index, items.length);
    appendTile(item, level, start, end, middle, ring.inner, ring.outer, segments, layer,
      animate ? { index, count: items.length } : undefined);
  });
  if (editing && items.length === 0) {
    const [start, end] = fanAngles(level, center, 0, 1);
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", ringSegmentPath(start, end, ring.inner, ring.outer));
    path.setAttribute("class", "submenu-empty-slot");
    path.dataset.level = String(level);
    segments.appendChild(path);
    if (animate) path.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 115, easing: "ease-out" });
  }
  const placeholder = document.createElementNS(SVG_NS, "path");
  placeholder.setAttribute("class", "child-drop-indicator drop-indicator");
  placeholder.dataset.level = String(level);
  segments.appendChild(placeholder);
}

function refreshSubmenus(firstLevel: 1 | 2, openingLevel?: 1 | 2) {
  const segments = app.querySelector<SVGGElement>(".child-segments")!;
  const layer = app.querySelector<HTMLDivElement>(".item-layer")!;
  for (const level of [1, 2] as const) {
    if (level < firstLevel) continue;
    window.cancelAnimationFrame(childLayoutAnimations[level]);
    displayedChildAngles[level] = [];
    segments.querySelectorAll(`[data-level="${level}"]`).forEach((node) => node.remove());
    layer.querySelectorAll(`[data-level="${level}"]`).forEach((node) => node.remove());
    const parent = activeSubmenus[level - 1];
    if (parent) {
      renderChildRing(parent, level, segments, layer, appearance.animations && level === openingLevel);
      updateChildDropIndicator(level, false);
    }
  }
  app.querySelectorAll<HTMLElement | SVGGElement>(".segment, .shortcut").forEach((tile) => {
    const id = tile.dataset.id!;
    tile.classList.toggle("active-submenu", activeSubmenus.includes(id));
    if (editing) {
      const selected = selectedTileId === id;
      if (tile instanceof HTMLButtonElement) tile.setAttribute("aria-pressed", String(selected));
      else tile.classList.toggle("selected-tile", selected);
    }
  });
}

function render(transition?: "opening" | "search") {
  const animateOpening = appearance.animations && transition === "opening";
  const animateSearch = appearance.animations && transition === "search";
  const previousAngles = animateSearch ? new Map(Array.from(
    app.querySelectorAll<SVGGElement>(".ring-segments .segment"),
    (segment, index) => [segment.dataset.id, displayedAngles[index]] as const,
  )) : null;
  cancelTileReorder(false);
  const focused = shortcuts.find((item) => item.id === focusedSubmenuId && item.kind === "submenu");
  if (focusedSubmenuId !== null && !focused) activeSubmenus = [];
  focusedSubmenuId = focused?.id ?? null;
  const searching = Boolean(searchQuery.trim());
  const matches = searching ? searchMatches(searchQuery) : [];
  const preferredIndex = matches.findIndex((item) => item.id === selectedSearchId);
  if (preferredIndex < 0) selectedSearchId = null;
  const selectedIndex = Math.max(0, preferredIndex);
  const selectedResult = matches[selectedIndex];
  const pageStart = Math.floor(selectedIndex / MAX_ITEMS) * MAX_ITEMS;
  const roots = searching ? matches.slice(pageStart, pageStart + MAX_ITEMS) : childrenOf(focusedSubmenuId);
  window.cancelAnimationFrame(layoutAnimation);
  childLayoutAnimations.forEach((animation) => window.cancelAnimationFrame(animation));
  childLayoutAnimations = [0, 0, 0];
  displayedChildAngles = [[], [], []];
  const targetAngles = roots.map((_, index): [number, number] => {
    const [start, end] = segmentAngles(index, roots.length);
    return [start, end];
  });
  displayedAngles = targetAngles;
  app.style.setProperty("--tile-size", `${appearance.shellSize}px`);
  app.style.setProperty("--content-scale", `${Math.min(1, appearance.shellSize / 620)}`);
  app.style.setProperty("--text-size", `${appearance.textSize}px`);
  app.style.setProperty("--border-thickness", `${appearance.borderThickness}px`);
  const emptyRadius = (OUTER + appearance.innerRadius) / 2;
  const emptyWidth = OUTER - appearance.innerRadius;
  const stageMarkup = `
    <main class="stage ${dragging ? "is-dragging" : ""} ${editing ? "is-editing" : ""}">
      <div class="palette" aria-label="Wayfinder shortcut palette">
        <svg class="ring-svg" viewBox="0 0 620 620" aria-hidden="true">
          ${roots.length ? "" : `<circle class="ring-empty" cx="310" cy="310" r="${emptyRadius}" stroke-width="${emptyWidth}" />`}
          <g class="ring-segments"></g>
          <g class="child-segments"></g>
          <path class="root-drop-indicator drop-indicator" />
        </svg>
        <div class="item-layer"></div>
        ${searching ? `<div class="search-summary" style="--focus-width: ${appearance.innerRadius * 1.6 / 620 * 100}%" role="status">
          <span>${matches.length > MAX_ITEMS ? `${pageStart + 1}–${pageStart + roots.length} of ` : ""}${matches.length ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : "No matches"}</span>
          ${selectedResult ? '<span class="search-breadcrumb"></span>' : ""}
        </div>` : focused ? `<div class="focus-controls" style="--focus-width: ${appearance.innerRadius * 1.6 / 620 * 100}%">
          <span class="focus-title"></span>
          <button class="focus-back" type="button">Back</button>
        </div>` : `<button class="edit-button" type="button" aria-label="${editing ? "Finish editing" : "Edit shortcuts"}" title="${editing ? "Done editing" : "Edit shortcuts"}" aria-pressed="${editing}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${editing
            ? '<path d="m9.2 16.3-4.5-4.5-1.7 1.7 6.2 6.2L21 7.9l-1.7-1.7z"/>'
            : `<path d="M10 2h4l.5 3 1.5.9 2.8-1.1 2 3.4-2.3 1.9v1.8l2.3 1.9-2 3.4-2.8-1.1-1.5.9-.5 3h-4l-.5-3-1.5-.9-2.8 1.1-2-3.4 2.3-1.9v-1.8L3.2 8.2l2-3.4L8 5.9 9.5 5 10 2Zm2 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" fill-rule="evenodd" transform="translate(0 1)"/>`}</svg>
        </button>`}
        ${!searching && !roots.length ? '<div class="empty-prompt"><span class="drop-arrow">↓</span><span>DRAG & DROP<br/>NEW ITEMS HERE</span></div>' : ""}
        <div class="toast" role="status" aria-live="polite"></div>
      </div>
    </main>
  `;
  const stage = app.querySelector(".stage");
  if (stage) {
    stage.outerHTML = stageMarkup;
  } else {
    app.innerHTML = `<label class="palette-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg>
      <input id="palette-search" type="text" aria-label="Search shortcuts" placeholder="Search shortcuts" autocomplete="off" spellcheck="false" />
    </label>${stageMarkup}`;
    bindPaletteSearch(app.querySelector<HTMLInputElement>("#palette-search")!);
  }
  const searchField = app.querySelector<HTMLInputElement>("#palette-search")!;
  const search = searchField.parentElement!;
  search.hidden = editing;
  search.classList.toggle("is-searching", searching);
  searchField.tabIndex = searching ? 0 : -1;
  if (searchField.value !== searchQuery) searchField.value = searchQuery;
  if (selectedResult) {
    const breadcrumb = app.querySelector<HTMLElement>(".search-breadcrumb")!;
    breadcrumb.textContent = shortcutBreadcrumb(selectedResult);
    breadcrumb.title = breadcrumb.textContent;
  }

  const segments = document.querySelector<SVGGElement>(".ring-segments")!;
  const childSegments = document.querySelector<SVGGElement>(".child-segments")!;
  const layer = document.querySelector<HTMLDivElement>(".item-layer")!;

  roots.forEach((item, index) => {
    const [start, end, middle] = segmentAngles(index, roots.length);
    const entering = animateOpening || (previousAngles && !previousAngles.has(item.id));
    appendTile(item, 0, start, end, middle, appearance.innerRadius, OUTER, segments, layer,
      entering ? { index, count: roots.length } : undefined, selectedResult?.id === item.id);
  });
  if ((animateOpening || previousAngles?.size) && !roots.length) {
    app.querySelector(".ring-empty")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 145, easing: "ease-out" });
  }
  if (!searching && activeSubmenus[0]) renderChildRing(activeSubmenus[0], 1, childSegments, layer, false);
  if (!searching && activeSubmenus[1]) renderChildRing(activeSubmenus[1], 2, childSegments, layer, false);

  if (!searching && focused) {
    const title = app.querySelector<HTMLElement>(".focus-title")!;
    title.textContent = focused.name || "Submenu";
    title.title = title.textContent;
    app.querySelector<HTMLButtonElement>(".focus-back")!.addEventListener("click", backFromFocus);
  }
  app.querySelector<HTMLButtonElement>(".edit-button")?.addEventListener("click", async () => {
    const nextEditing = !editing;
    try {
      await invoke("set_edit_window_visible", { visible: nextEditing });
      editing = nextEditing;
      if (editing) resetPaletteSearch();
      if (!editing) resetEditSelection();
      render();
    } catch (error) {
      showToast(String(error), true);
    }
  });
  if (previousAngles) {
    const from = roots.map((item, index): [number, number] => {
      const target = targetAngles[index];
      const previous = previousAngles.get(item.id);
      if (!previous) return target;
      const oldMiddle = (previous[0] + previous[1]) / 2;
      const offset = angleNear(oldMiddle, (target[0] + target[1]) / 2) - oldMiddle;
      return [previous[0] + offset, previous[1] + offset];
    });
    layoutRootTiles(targetAngles, from);
  } else {
    updateDropIndicator(false);
  }
  updateChildDropIndicator(1, false);
  updateChildDropIndicator(2, false);
}

async function removeItem(item: Shortcut) {
  if (busy) return;
  busy = true;
  try {
    await invoke("remove_shortcut", { id: item.id });
    shortcuts = await invoke<Shortcut[]>("list_shortcuts");
    const remainingIds = new Set(shortcuts.map((shortcut) => shortcut.id));
    for (const id of shortcutIcons.keys()) {
      if (!remainingIds.has(id)) shortcutIcons.delete(id);
    }
    if (selectedTileId && !remainingIds.has(selectedTileId)) resetEditSelection();
    else activeSubmenus = activeSubmenus.filter((id) => remainingIds.has(id));
    render();
    showToast(`Removed ${shortcutName(item)}`);
  } catch (error) {
    showToast(String(error), true);
  } finally {
    busy = false;
  }
}

function resetEditSelection() {
  activeSubmenus = [];
  selectedTileId = null;
  void emitTo("editor", "tile-selection-changed", null).catch(() => {});
}

function backFromFocus() {
  const focused = shortcuts.find((item) => item.id === focusedSubmenuId);
  focusedSubmenuId = focused?.parentId ?? null;
  activeSubmenus = [];
  render();
  const previousTile = Array.from(app.querySelectorAll<HTMLButtonElement>(".shortcut"))
    .find((tile) => tile.dataset.id === focused?.id);
  previousTile?.focus({ preventScroll: true });
}

async function activate(item: Shortcut, level: number, shiftKey: boolean) {
  if (busy) return;
  if (editing) {
    selectedTileId = item.id;
    if (item.kind !== "submenu") activeSubmenus = activeSubmenus.slice(0, level);
    if (!openSubmenu(item, level)) render();
    const { id, name, kind, path, text, color } = item;
    await emitTo("editor", "tile-selection-changed", { item: { id, name, kind, path, text, color }, level })
      .catch((error) => showToast(String(error), true));
    return;
  }
  if (item.kind === "submenu") {
    rememberShortcut(item.id);
    resetPaletteSearch();
    focusedSubmenuId = item.id;
    activeSubmenus = [];
    render();
    app.querySelector<HTMLButtonElement>(".focus-back")?.focus({ preventScroll: true });
    return;
  }
  busy = true;
  try {
    await invoke("dismiss_palette");
    activeSubmenus = [];
    render();
    await invoke("open_shortcut", { id: item.id, inTerminal: item.kind === "folder" && shiftKey });
    rememberShortcut(item.id);
  } catch (error) {
    try {
      await invoke("present_palette");
    } catch {
      // Preserve the original opening error below.
    }
    showToast(String(error), true);
  } finally {
    busy = false;
  }
}

async function addDroppedPaths(paths: string[], target: DropTarget | null) {
  if (busy || !paths.length) return;
  busy = true;
  dragging = false;
  const parentId = target?.parentId ?? focusedSubmenuId;
  try {
    const added = await invoke<Shortcut[]>("add_paths", { paths, parentId, index: target?.index });
    shortcuts = await invoke<Shortcut[]>("list_shortcuts");
    render();
    if (added.length) {
      showToast(`${added.length} shortcut${added.length === 1 ? "" : "s"} added`);
    } else {
      showToast(childrenOf(parentId).length >= MAX_ITEMS ? `This ring is full (${MAX_ITEMS} items)` : "No new files or folders found", true);
    }
  } catch (error) {
    render();
    showToast(String(error), true);
  } finally {
    busy = false;
  }
}

function tileValueFields(kind: EditableTileKind, id: string) {
  if (kind === "submenu") return "";
  if (kind === "text") return `
    <label for="${id}">Text to copy</label>
    <textarea id="${id}" name="value" rows="5" placeholder="Type or paste text here" required></textarea>`;
  const label = kind === "webpage" ? "Webpage URL" : kind === "folder" ? "Folder path" : kind === "file" ? "File path" : "App path (.exe or .lnk)";
  return `
    ${kind === "app" ? `<label for="${id}-apps">Installed apps</label>
    <input id="${id}-apps" class="installed-apps" type="text" list="${id}-app-options" placeholder="Loading apps…" autocomplete="off" spellcheck="false" disabled />
    <datalist id="${id}-app-options"></datalist>
    <div class="app-source-divider">or</div>` : ""}
    <label for="${id}">${label}</label>
    <div class="tile-path-row">
      <input id="${id}" name="value" type="text" required spellcheck="false" placeholder="${kind === "webpage" ? "https://example.com" : "Choose or paste a path"}" />
      ${kind !== "webpage" ? '<button class="tile-browse" type="button">Browse</button>' : ""}
    </div>`;
}

function bindTileValueFields(form: HTMLFormElement, fields: HTMLElement, kind: EditableTileKind, fillSuggestedName: boolean) {
  const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
  const value = fields.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="value"]');
  const appSearch = fields.querySelector<HTMLInputElement>(".installed-apps");
  const appOptions = fields.querySelector<HTMLDataListElement>("datalist");
  if (appSearch && appOptions && value) {
    void invoke<InstalledApp[]>("list_installed_apps").then((items) => {
      if (!appSearch.isConnected) return;
      const nameCounts = new Map<string, number>();
      for (const item of items) {
        const key = item.name.toLowerCase();
        nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
      }
      const choices = new Map(items.map((item) => [
        nameCounts.get(item.name.toLowerCase()) === 1 ? item.name : `${item.name} — ${item.path}`,
        item,
      ]));
      appOptions.replaceChildren(...Array.from(choices.keys(), (label) => new Option(label, label)));
      appSearch.placeholder = items.length ? "Search installed apps" : "No Start Menu apps found";
      appSearch.disabled = !items.length;
      const labelsByPath = new Map(Array.from(choices, ([label, item]) => [item.path, label]));
      const syncSearch = () => { appSearch.value = labelsByPath.get(value.value) ?? ""; };
      syncSearch();
      value.addEventListener("input", syncSearch);
      appSearch.addEventListener("input", () => {
        const selected = choices.get(appSearch.value);
        if (!selected) return;
        value.value = selected.path;
        if (fillSuggestedName && !name.value.trim()) name.value = selected.name;
      });
    }).catch(() => {
      appSearch.placeholder = "Browse or paste an app path below";
    });
  }
  fields.querySelector<HTMLButtonElement>(".tile-browse")?.addEventListener("click", async () => {
    try {
      const path = await invoke<string | null>("pick_tile_path", { kind });
      if (path && value?.isConnected) {
        value.value = path;
        if (kind === "folder" && fillSuggestedName && !name.value.trim()) {
          const folderName = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop()?.trim() ?? "";
          name.value = Array.from(folderName).slice(0, name.maxLength).join("");
        }
        value.dispatchEvent(new Event("input"));
      }
    } catch (error) {
      form.querySelector<HTMLElement>(".tile-form-error")!.textContent = String(error);
    }
  });
  return value;
}

function editableKind(kind: Shortcut["kind"]): EditableTileKind {
  return tileDefinitions.find((definition) => definition.kind === kind)?.kind ?? "file";
}

function tileColorField() {
  const families = Array.from(tailwindColorGroups, ([family, tokens]) => {
    const token = tokens.includes(`${family}-500`) ? `${family}-500` : tokens[0];
    return `<button class="tile-color-swatch" type="button" data-color-family="${family}" data-color-token="${token}" aria-label="${colorName(family)}" title="${colorName(family)}" aria-pressed="false" style="--swatch: ${tailwindColors[token]}"></button>`;
  }).join("");
  return `<details class="tile-color-picker">
    <summary>
      <span>Color label <small class="tile-name-hint">(Optional)</small></span>
      <span class="tile-color-preview" aria-hidden="true" hidden></span>
      <svg class="tile-color-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.5l5 5 5-5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </summary>
    <div class="tile-color-options">
      <button class="tile-color-clear" type="button" aria-label="Clear color label">Clear</button>
      <div class="tile-color-families" role="group" aria-label="Color families">${families}</div>
      <div class="tile-color-existing" hidden><span class="tile-color-swatch" aria-hidden="true"></span>Existing color</div>
      <div class="tile-color-shades" hidden>
        <div class="tile-shade-heading"></div>
        <div class="tile-shade-grid" role="group" aria-label="Shades"></div>
      </div>
    </div>
  </details>`;
}

function colorName(token: string) {
  return token[0].toUpperCase() + token.slice(1).replace("-", " ");
}

function bindTileColor(form: HTMLFormElement, color?: string | null) {
  const picker = form.querySelector<HTMLElement>(".tile-color-picker")!;
  const preview = picker.querySelector<HTMLElement>(".tile-color-preview")!;
  const clear = picker.querySelector<HTMLButtonElement>(".tile-color-clear")!;
  const existing = picker.querySelector<HTMLElement>(".tile-color-existing")!;
  const shades = picker.querySelector<HTMLElement>(".tile-color-shades")!;
  const grid = picker.querySelector<HTMLElement>(".tile-shade-grid")!;
  const heading = picker.querySelector<HTMLElement>(".tile-shade-heading")!;
  const families = picker.querySelectorAll<HTMLButtonElement>("[data-color-family]");
  let selected = color && tileLabelColor(color) ? color : null;
  const render = () => {
    const family = selected && Object.hasOwn(tailwindColors, selected) ? selected.split("-")[0] : null;
    const tokens = family ? tailwindColorGroups.get(family)! : [];
    preview.hidden = !selected;
    preview.style.backgroundColor = tileLabelColor(selected) ?? "";
    clear.disabled = !selected;
    existing.hidden = !selected || family !== null;
    existing.style.setProperty("--swatch", existing.hidden ? "transparent" : tileLabelColor(selected)!);
    shades.hidden = tokens.length <= 1;
    if (family && !shades.hidden && grid.dataset.family !== family) {
      heading.textContent = `${colorName(family)} shades`;
      grid.setAttribute("aria-label", heading.textContent);
      grid.dataset.family = family;
      grid.innerHTML = tokens.map((token) => `<button class="tile-shade" type="button" data-color-token="${token}" aria-label="${colorName(token)}" title="${colorName(token)}">
        <span class="tile-color-swatch" style="--swatch: ${tailwindColors[token]}" aria-hidden="true"></span>
        <span aria-hidden="true">${token.split("-")[1]}</span>
      </button>`).join("");
    }
    families.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.colorFamily === family)));
    grid.querySelectorAll<HTMLButtonElement>(".tile-shade").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.colorToken === selected));
    });
  };
  picker.addEventListener("click", (event) => {
    const button = (event.target as Element).closest<HTMLButtonElement>("button");
    if (button === clear) {
      selected = null;
    } else if (button?.dataset.colorToken) {
      if (button.dataset.colorFamily && button.getAttribute("aria-pressed") === "true") return;
      selected = button.dataset.colorToken;
    } else {
      return;
    }
    render();
  });
  render();
  return () => selected;
}

const settingsIconPaths = {
  about: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 11v5m0-8h.01",
  tiles: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  "edit-tile": "m13.5 6.5 4 4M4 20l4.5-1 11-11a2.8 2.8 0 0 0-4-4l-11 11L4 20z",
  appearance: "M3 6h5m4 0h9M3 12h9m4 0h5M3 18h3m4 0h11M8 4v4m8 2v4M6 16v4",
  theme: "M12 3a9 9 0 1 0 0 18h1.5a1.5 1.5 0 0 0 1.1-2.5 1.5 1.5 0 0 1 1.1-2.5H18a3 3 0 0 0 3-3c0-5.5-4-10-9-10zM7.5 12h.01m2-4h.01m4-.5h.01m3.5 3h.01",
  misc: "M9 7v10a2 2 0 1 1-2-2h10a2 2 0 1 1-2 2V7a2 2 0 1 1 2 2H7a2 2 0 1 1 2-2z",
  submenu: "m6 6 6 6-6 6m6-12 6 6-6 6",
  text: "M4 6h16M4 10h12M4 14h16M4 18h12",
  folder: "M3 6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  webpage: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a13 13 0 0 0 0 18 13 13 0 0 0 0-18z",
  app: "M3 5h18v14H3zM3 9h18m-14-2h.01m3 0h.01",
  selection: "m4 3 6 17 3-7 7-3L4 3z",
  grip: "M9 5h.01m6 0h.01M9 12h.01m6 0h.01M9 19h.01m6 0h.01",
};

function settingsIcon(name: keyof typeof settingsIconPaths) {
  return `<svg class="settings-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${settingsIconPaths[name]}"/></svg>`;
}

function settingsHeading(title: string, description: string) {
  return `<header class="settings-heading"><h1>${title}</h1><p>${description}</p></header>`;
}

function selectedTileForm(selection: TileSelection) {
  const types = [...tileDefinitions, { kind: "file", label: "File" }];
  return `
    <div class="tile-selection-summary">
      <span class="tile-source-icon">${settingsIcon("selection")}</span>
      <span class="tile-source-copy"><strong data-selection-name></strong><small data-selection-kind></small></span>
    </div>
    <form id="tile-edit-form" class="tile-form tile-edit-form" aria-label="Selected tile">
      <label for="edit-tile-kind">Type</label>
      <select id="edit-tile-kind" name="kind">
        ${types.filter(({ kind }) => kind !== "submenu" || selection.level < 2).map(({ kind, label }) => `<option value="${kind}">${label}</option>`).join("")}
      </select>
      <label for="edit-tile-name">Name <small class="tile-name-hint" hidden></small></label>
      <input id="edit-tile-name" name="name" type="text" maxlength="80" autocomplete="off" />
      <div class="tile-fields"></div>
      ${tileColorField()}
      <div class="tile-form-error" role="alert"></div>
      <div class="tile-form-actions"><button class="tile-save" type="submit">Save changes</button></div>
    </form>`;
}

function bindSelectedTileForm(form: HTMLFormElement, selection: TileSelection) {
  const type = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
  const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
  const nameHint = form.querySelector<HTMLElement>(".tile-name-hint")!;
  const fields = form.querySelector<HTMLElement>(".tile-fields")!;
  const error = form.querySelector<HTMLElement>(".tile-form-error")!;
  const save = form.querySelector<HTMLButtonElement>(".tile-save")!;
  const { item } = selection;
  const selectedColor = bindTileColor(form, item.color);
  let kind = editableKind(item.kind);
  app.querySelector<HTMLElement>("[data-selection-name]")!.textContent = item.kind === "text"
    ? shortcutName(item)
    : item.name || tileDefinitions.find((tile) => tile.kind === kind)?.label || "File";
  const selectionKind = app.querySelector<HTMLElement>("[data-selection-kind]")!;
  const values = new Map<EditableTileKind, string>([[kind, kind === "text" ? item.text ?? "" : item.path]]);
  let value: HTMLInputElement | HTMLTextAreaElement | null;
  const renderFields = () => {
    selectionKind.textContent = type.selectedOptions[0]?.textContent ?? "";
    const hint = tileNameHints[kind];
    nameHint.textContent = hint ?? "";
    nameHint.hidden = !hint;
    name.placeholder = hint ? "" : "Optional name";
    fields.innerHTML = tileValueFields(kind, "edit-tile-value");
    value = bindTileValueFields(form, fields, kind, false);
    if (value) value.value = values.get(kind) ?? "";
  };
  name.value = item.name;
  type.value = kind;
  renderFields();
  type.addEventListener("change", () => {
    if (value) values.set(kind, value.value);
    kind = type.value as EditableTileKind;
    error.textContent = "";
    renderFields();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const details = { id: item.id, kind, name: name.value, value: value?.value ?? "", color: selectedColor() };
    const controls = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(":is(input, textarea, select, button):enabled");
    controls.forEach((control) => { control.disabled = true; });
    error.textContent = "";
    try {
      const updated = await invoke<Shortcut>("update_tile", details);
      if (selectedTile !== selection) return;
      selectedTile = { ...selection, item: updated };
      renderEditor();
      app.querySelector<HTMLElement>(".settings-status")!.textContent = "Tile updated";
    } catch (failure) {
      error.textContent = String(failure);
      controls.forEach((control) => { control.disabled = false; });
      save.focus();
    }
  });
}

function displayHotkey(combination: string) {
  return combination.split("+").map((part) => ({
    control: "Ctrl", shift: "Shift", alt: "Alt", super: "Win",
    MouseLeft: "Left click", MouseRight: "Right click", MouseMiddle: "Middle click",
    MouseBack: "Mouse Back", MouseForward: "Mouse Forward",
  }[part] ?? part.replace(/^(Key|Digit)(?=[A-Z0-9]$)/, ""))).join(" + ");
}

let editorHeightObserver: ResizeObserver | undefined;

function observeEditorHeight() {
  const settings = app.querySelector<HTMLElement>(".settings");
  if (!settings) return;
  const form = app.querySelector<HTMLFormElement>("#tile-create-form");
  editorHeightObserver?.disconnect();
  editorHeightObserver = new ResizeObserver(() => {
    let height = settings.scrollHeight;
    if (form) {
      const backdrop = getComputedStyle(form.parentElement!);
      const frame = form.offsetHeight - form.clientHeight;
      height = Math.max(height, form.scrollHeight + frame + parseFloat(backdrop.paddingTop) + parseFloat(backdrop.paddingBottom));
    }
    void invoke("fit_editor_height", { height: Math.ceil(height) }).catch(() => {});
  });
  editorHeightObserver.observe(settings);
  if (form) {
    editorHeightObserver.observe(form);
    for (const child of form.children) editorHeightObserver.observe(child);
  }
}

function renderEditor() {
  const nameRequired = tileForm?.kind === "folder";
  const nameHint = nameRequired ? "(Required)" : tileForm ? tileNameHints[tileForm.kind] : undefined;
  const tabs = [["tiles", "Tiles"], ["edit-tile", "Edit tile"], ["appearance", "Appearance"], ["theme", "Theme"], ["misc", "Behavior"], ["about", "About"]] as const;
  const inactive = (tab: EditorTab) => editorTab === tab ? "" : 'inert aria-hidden="true"';
  app.innerHTML = `
    <section class="settings" aria-label="Palette settings">
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        ${tabs.map(([id, label]) => `<button class="settings-tab" data-tab="${id}" type="button" role="tab" aria-selected="${editorTab === id}" aria-controls="${id}-panel" tabindex="${editorTab === id ? 0 : -1}">${settingsIcon(id)}${label}</button>`).join("")}
      </div>
      <div class="settings-content">
      <div class="settings-panels">
      <div class="tiles-panel" id="tiles-panel" role="tabpanel" aria-label="Tiles" ${inactive("tiles")}>
        ${settingsHeading("Tiles", "Drag a tile onto the palette or click to add it at the end.")}
        <div class="tile-sources">${tileDefinitions.map(({ kind, label, detail }) => `
          <button class="tile-source" type="button" draggable="true" data-kind="${kind}" aria-label="Add ${label}">
            <span class="tile-source-icon">${settingsIcon(kind)}</span>
            <span class="tile-source-copy"><strong>${label}</strong><small>${detail}</small></span>
            <span class="tile-source-grip">${settingsIcon("grip")}</span>
          </button>
        `).join("")}</div>
      </div><div id="edit-tile-panel" role="tabpanel" aria-label="Edit tile" ${inactive("edit-tile")}>
        ${settingsHeading("Edit tile", selectedTile ? "Manage the tile selected on your palette." : "Select a tile on the palette to edit it.")}
        ${selectedTile && editorTab === "edit-tile" ? selectedTileForm(selectedTile) : ""}
      </div><div class="appearance-panel" id="appearance-panel" role="tabpanel" aria-label="Appearance" ${inactive("appearance")}>
        ${settingsHeading("Appearance", "Adjust the shape and spacing of your palette.")}
        ${["Geometry", "Spacing"].map((group) => `
          <h2 class="settings-group-heading">${group}</h2>
          <div class="settings-range-grid">
            ${sliderDefinitions.filter((definition) => definition.group === group).map(({ key, label, min, max }) => `
              <div class="setting-range">
                <label for="setting-${key}">${label}</label>
                <span class="setting-value setting-stepper">
                  <input id="setting-${key}-value" type="number" aria-label="${label} in pixels" min="${min}" max="${max}" step="1" value="${appearance[key]}" />
                  <span aria-hidden="true">px</span>
                </span>
                <input id="setting-${key}" data-key="${key}" type="range" min="${min}" max="${max}" value="${appearance[key]}" />
              </div>`).join("")}
          </div>`).join("")}
      </div><div class="theme-panel" id="theme-panel" role="tabpanel" aria-label="Theme" ${inactive("theme")}>
        ${settingsHeading("Theme", "Choose a preset or customize the palette colors.")}
        <div class="setting-row">
          <label for="theme-preset">Preset</label>
          <select id="theme-preset">
            <option value="" disabled>Custom</option>
            ${themePresets.map(({ id, label }) => `<option value="${id}">${label}</option>`).join("")}
          </select>
        </div>
        ${themeColors.map(({ key, label }) => `
          <div class="setting-row">
            <label for="theme-${key}">${label}</label>
            <span class="setting-color">
              <span class="setting-value" data-theme-value="${key}" aria-hidden="true"></span>
              <input id="theme-${key}" type="color" />
            </span>
          </div>
        `).join("")}
      </div><div id="misc-panel" role="tabpanel" aria-label="Behavior" ${inactive("misc")}>
        ${settingsHeading("Behavior", "Control how the palette opens and moves.")}
        <h2 class="settings-group-heading">Shortcut</h2>
        <div class="setting-row">
          <label for="palette-hotkey">Open palette</label>
          <input id="palette-hotkey" type="text" readonly placeholder="Press a shortcut" aria-describedby="hotkey-note" />
        </div>
        <p class="setting-note" id="hotkey-note">Select the shortcut, then press a key combination or use a modifier with a mouse button.</p>
        <h2 class="settings-group-heading">Window</h2>
        <label class="setting-row">
          <span>Enable animations</span>
          <input id="palette-animations" class="setting-switch" type="checkbox" role="switch" ${appearance.animations ? "checked" : ""} />
        </label>
        <label class="setting-row">
          <span>Open at screen center</span>
          <input id="palette-screen-center" class="setting-switch" type="checkbox" role="switch" ${appearance.openAtScreenCenter ? "checked" : ""} />
        </label>
        <label class="setting-row">
          <span>Cast shadow</span>
          <input id="palette-cast-shadow" class="setting-switch" type="checkbox" role="switch" ${appearance.castShadow ? "checked" : ""} />
        </label>
      </div><div id="about-panel" role="tabpanel" aria-label="About" ${inactive("about")}>
        <header class="settings-heading"><h1>About Wayfinder</h1></header>
        <dl class="about-details">
          <div class="setting-row"><dt>Version</dt><dd>${appVersion}</dd></div>
          <div class="setting-row"><dt>Author</dt><dd>Vee Jay</dd></div>
        </dl>
        <p class="setting-note">© 2026 Vee Jay</p>
      </div>
      </div>
      <div class="settings-status" role="status" aria-live="polite"></div>
      </div>
    </section>
    ${tileForm ? `<div class="form-backdrop">
      <form id="tile-create-form" class="tile-form" aria-label="Add ${tileForm.kind} tile">
        <h2>Add ${tileDefinitions.find((item) => item.kind === tileForm!.kind)!.label}</h2>
        <p>Slot ${tileForm.index + 1} ${tileForm.parentId ? "in the submenu" : "on the root ring"}</p>
        <label for="tile-name">Name${nameHint ? ` <small class="tile-name-hint">${nameHint}</small>` : ""}</label>
        <input id="tile-name" name="name" type="text" maxlength="80" ${nameRequired ? "required" : nameHint ? "" : 'placeholder="Optional name"'} autocomplete="off" />
        <div class="tile-fields">${tileValueFields(tileForm.kind, "tile-value")}</div>
        ${tileColorField()}
        <div class="tile-form-error" role="alert"></div>
        <div class="tile-form-actions"><button class="tile-cancel" type="button">Cancel</button><button class="tile-save" type="submit">Save tile</button></div>
      </form>
    </div>` : ""}
  `;

  applyPreferences();
  const hotkey = app.querySelector<HTMLInputElement>("#palette-hotkey");
  if (hotkey) {
    hotkey.value = paletteHotkey ? displayHotkey(paletteHotkey) : "";
    const capture = async (event: KeyboardEvent | MouseEvent, button: string) => {
      if (savingHotkey) return;
      const status = app.querySelector<HTMLElement>(".settings-status");
      const modifiers = [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift",
        event.metaKey && "Super"].filter(Boolean);
      if (!modifiers.length && !/^F\d+$/.test(button)) {
        if (event instanceof KeyboardEvent && status) status.textContent = "Use a modifier key or a function key.";
        return;
      }
      event.preventDefault();
      const combination = [...modifiers, button].join("+");
      savingHotkey = true;
      try {
        paletteHotkey = await invoke<string>("set_palette_hotkey", { combination });
        const field = app.querySelector<HTMLInputElement>("#palette-hotkey");
        if (field) field.value = displayHotkey(paletteHotkey);
        if (status) status.textContent = "Hotkey saved";
      } catch (error) {
        if (status) status.textContent = `Could not change hotkey: ${String(error)}`;
      } finally {
        savingHotkey = false;
      }
    };
    hotkey.addEventListener("keydown", (event) => {
      if (event.key === "Tab" || event.key === "Escape") return;
      if (event.repeat || /^(Control|Shift|Alt|Meta|OS)(Left|Right)$/.test(event.code)) return;
      void capture(event, event.code);
    });
    hotkey.addEventListener("mousedown", (event) => {
      const button = ["MouseLeft", "MouseMiddle", "MouseRight", "MouseBack", "MouseForward"][event.button];
      if (button) void capture(event, button);
    });
    hotkey.addEventListener("contextmenu", (event) => event.preventDefault());
  }
  const animations = app.querySelector<HTMLInputElement>("#palette-animations");
  animations?.addEventListener("change", () => {
    appearance.animations = animations.checked;
    applyPreferences();
    previewAppearance();
    scheduleAppearanceSave(true);
  });
  const screenCenter = app.querySelector<HTMLInputElement>("#palette-screen-center");
  screenCenter?.addEventListener("change", () => {
    appearance.openAtScreenCenter = screenCenter.checked;
    scheduleAppearanceSave(true);
  });
  const castShadow = app.querySelector<HTMLInputElement>("#palette-cast-shadow");
  castShadow?.addEventListener("change", () => {
    appearance.castShadow = castShadow.checked;
    applyPreferences();
    previewAppearance();
    scheduleAppearanceSave(true);
  });
  const presetSelect = app.querySelector<HTMLSelectElement>("#theme-preset");
  if (presetSelect) {
    presetSelect.addEventListener("change", () => {
      const preset = themePresets.find(({ id }) => id === presetSelect.value);
      if (!preset) return;
      Object.assign(appearance.theme, preset.colors);
      applyPreferences();
      previewAppearance();
      scheduleAppearanceSave(true);
    });
    for (const { key } of themeColors) {
      const input = app.querySelector<HTMLInputElement>(`#theme-${key}`)!;
      input.addEventListener("input", () => {
        appearance.theme[key] = input.value;
        applyPreferences();
        previewAppearance();
        scheduleAppearanceSave();
      });
      input.addEventListener("change", () => scheduleAppearanceSave(true));
    }
  }

  const selectTab = (id: EditorTab) => {
    editorTab = id;
    renderEditor();
    app.scrollTop = 0;
    app.querySelector<HTMLButtonElement>(`[data-tab="${id}"]`)?.focus({ preventScroll: true });
  };
  app.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tabs[index][0]));
    tab.addEventListener("keydown", (event) => {
      let next: number;
      switch (event.key) {
        case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
        case "ArrowRight": next = (index + 1) % tabs.length; break;
        case "Home": next = 0; break;
        case "End": next = tabs.length - 1; break;
        default: return;
      }
      event.preventDefault();
      selectTab(tabs[next][0]);
    });
  });

  app.querySelectorAll<HTMLButtonElement>(".tile-source").forEach((source) => {
    const kind = source.dataset.kind as TileKind;
    source.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("application/x-wayfinder-tile", kind);
      event.dataTransfer?.setData("text/plain", `wayfinder-tile:${kind}`);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      void invoke("begin_tile_drag", { kind });
    });
    source.addEventListener("dragend", () => {
      void invoke("end_tile_drag");
    });
    source.addEventListener("click", async () => {
      try {
        const items = await invoke<Shortcut[]>("list_shortcuts");
        const rootCount = items.filter((item) => !item.parentId).length;
        if (rootCount >= MAX_ITEMS) throw new Error(`Root ring is full (${MAX_ITEMS} items)`);
        openTileForm(kind, rootCount, null);
      } catch (error) {
        const status = app.querySelector<HTMLElement>(".settings-status");
        if (status) status.textContent = String(error);
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>("input[type=range]").forEach((input) => {
    const { key, min, max } = sliderDefinitions.find((item) => item.key === input.dataset.key)!;
    const number = app.querySelector<HTMLInputElement>(`#setting-${key}-value`)!;
    const updateTrack = (value: number) => {
      input.style.setProperty("--progress", `${(value - min) / (max - min) * 100}%`);
    };
    const apply = (value: number) => {
      if (appearance[key] === value) return;
      appearance[key] = value;
      input.valueAsNumber = value;
      updateTrack(value);
      previewAppearance();
    };
    updateTrack(appearance[key]);
    input.addEventListener("input", () => {
      const value = input.valueAsNumber;
      number.valueAsNumber = value;
      apply(value);
      scheduleAppearanceSave();
    });
    input.addEventListener("change", () => scheduleAppearanceSave(true));
    number.addEventListener("input", () => {
      const value = number.valueAsNumber;
      if (!Number.isInteger(value) || value < min || value > max) return;
      apply(value);
      scheduleAppearanceSave();
    });
    number.addEventListener("change", () => {
      const entered = number.valueAsNumber;
      const value = Number.isFinite(entered) ? Math.min(max, Math.max(min, Math.round(entered))) : appearance[key];
      number.valueAsNumber = value;
      apply(value);
      scheduleAppearanceSave(true);
    });
  });

  const editForm = app.querySelector<HTMLFormElement>("#tile-edit-form");
  if (editForm && selectedTile) bindSelectedTileForm(editForm, selectedTile);
  const form = app.querySelector<HTMLFormElement>("#tile-create-form");
  if (form && tileForm) {
    const valueField = bindTileValueFields(form, form.querySelector<HTMLElement>(".tile-fields")!, tileForm.kind, true);
    const nameField = form.querySelector<HTMLInputElement>("#tile-name")!;
    const selectedColor = bindTileColor(form);
    form.querySelector<HTMLButtonElement>(".tile-cancel")!.addEventListener("click", () => {
      tileForm = null;
      renderEditor();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const current = tileForm;
      if (!current) return;
      const save = form.querySelector<HTMLButtonElement>(".tile-save")!;
      save.disabled = true;
      const name = nameField.value;
      const value = valueField?.value ?? "";
      try {
        await invoke("create_tile", { kind: current.kind, name, value, index: current.index, parentId: current.parentId, color: selectedColor() });
        tileForm = null;
        renderEditor();
        app.querySelector<HTMLElement>(".settings-status")!.textContent = "Tile added";
      } catch (error) {
        form.querySelector<HTMLElement>(".tile-form-error")!.textContent = String(error);
        save.disabled = false;
      }
    });
    (valueField ?? nameField).focus();
  }
  observeEditorHeight();
}

function openTileForm(kind: TileKind, index: number, parentId: string | null) {
  editorTab = "tiles";
  tileForm = { kind, index, parentId };
  renderEditor();
}

function previewAppearance() {
  void invoke("preview_appearance", { appearance }).catch((error) => {
    const status = app.querySelector<HTMLElement>(".settings-status");
    if (status) status.textContent = `Could not preview: ${String(error)}`;
  });
}

function scheduleAppearanceSave(immediate = false) {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  const save = () => {
    const snapshot = { ...appearance, theme: { ...appearance.theme } };
    saveQueue = saveQueue.then(async () => {
      try {
        await invoke<Appearance>("set_appearance", { appearance: snapshot });
        const status = app.querySelector<HTMLElement>(".settings-status");
        if (status) status.textContent = "Saved";
      } catch (error) {
        const status = app.querySelector<HTMLElement>(".settings-status");
        if (status) status.textContent = `Could not save: ${String(error)}`;
      }
    });
  };
  if (immediate) save();
  else saveTimer = window.setTimeout(save, 140);
}

async function startEditor() {
  try {
    await listen<TileSelection | null>("tile-selection-changed", ({ payload }) => {
      if (!payload || selectedTile?.item.id !== payload.item.id || editorTab !== "edit-tile" || tileForm) {
        selectedTile = payload;
        tileForm = null;
        if (payload) editorTab = "edit-tile";
        renderEditor();
        if (payload) app.scrollTop = 0;
      }
    });
    await listen<[TileKind, number, string | null]>("tile-form-requested", (event) => {
      const [kind, index, parentId] = event.payload;
      openTileForm(kind, index, parentId);
    });
    [appearance, paletteHotkey] = await Promise.all([
      invoke<Appearance>("get_appearance"),
      invoke<string | null>("get_palette_hotkey"),
    ]);
    renderEditor();
    window.addEventListener("focus", observeEditorHeight);
  } catch (error) {
    app.textContent = `Could not load appearance settings: ${String(error)}`;
  }
}

let openingPalette = false;

async function openPalette() {
  if (openingPalette) return;
  openingPalette = true;
  try {
    resetPaletteSearch();
    activeSubmenus = [];
    render("opening");
    const entrance = app.getAnimations({ subtree: true });
    for (const animation of entrance) {
      animation.pause();
      animation.currentTime = 0;
    }
    // Resolve the entrance styles before making the native window visible.
    app.getBoundingClientRect();
    await invoke("present_palette");
    app.querySelector<HTMLInputElement>("#palette-search")?.focus({ preventScroll: true });
    for (const animation of entrance) animation.play();
  } finally {
    openingPalette = false;
  }
}

async function start() {
  let ready = false;
  try {
    await listen("palette-opening", () => {
      if (ready) void openPalette().catch((error) => showToast(String(error), true));
    });
    await listen<TileKind>("tile-drag-start", (event) => {
      incomingTileKind = event.payload;
      tileDropHandled = false;
      if (dragging || searchQuery) {
        resetPaletteSearch();
        dragging = false;
        render();
      }
    });
    await listen<[number, number] | null>("tile-drag-position", (event) => {
      if (!incomingTileKind) return;
      if (event.payload) previewDropAt(event.payload[0] / window.devicePixelRatio, event.payload[1] / window.devicePixelRatio);
      else clearDropTarget();
    });
    await listen<[TileKind, number, number]>("tile-drag-finished", (event) => {
      if (tileDropHandled) return;
      const [kind, x, y] = event.payload;
      const target = dropTargetAt(x / window.devicePixelRatio, y / window.devicePixelRatio, kind);
      if (target) void finishTileDrop(kind, target);
    });
    await listen("tile-drag-end", () => {
      incomingTileKind = null;
      clearDropTarget();
    });
    await listen("shortcuts-changed", async () => {
      const updated = await invoke<Shortcut[]>("list_shortcuts");
      for (const previous of shortcuts) {
        const current = updated.find((item) => item.id === previous.id);
        if (!current || current.path !== previous.path || current.kind !== previous.kind) shortcutIcons.delete(previous.id);
      }
      shortcuts = updated;
      const closed = activeSubmenus.findIndex((id) => !shortcuts.some((item) => item.id === id && item.kind === "submenu"));
      if (closed !== -1) activeSubmenus = activeSubmenus.slice(0, closed);
      render();
    });
    await listen("editor-closed", () => {
      if (editing) {
        editing = false;
        resetEditSelection();
        render();
      }
    });
    await listen<Appearance>("appearance-changed", (event) => {
      const geometryChanged = sliderDefinitions.some(({ key }) => key !== "shellSize" && event.payload[key] !== appearance[key]);
      const shellChanged = event.payload.shellSize !== appearance.shellSize;
      const animationsDisabled = appearance.animations && !event.payload.animations;
      appearance = event.payload;
      applyPreferences();
      if (geometryChanged || animationsDisabled) render();
      else if (shellChanged) {
        app.style.setProperty("--tile-size", `${appearance.shellSize}px`);
        app.style.setProperty("--content-scale", `${Math.min(1, appearance.shellSize / 620)}`);
      }
    });
    [shortcuts, appearance] = await Promise.all([
      invoke<Shortcut[]>("list_shortcuts"),
      invoke<Appearance>("get_appearance"),
    ]);
    applyPreferences();
    app.addEventListener("pointerdown", () => { suppressTileClick = false; }, true);
    app.addEventListener("click", (event) => {
      if (suppressTileClick && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    }, true);
    app.addEventListener("pointerup", (event) => {
      if (editing || tileReorder || incomingTileKind || externalDragging || suppressTileClick) return;
      const target = event.target as Element;
      if (!target.closest(".shortcut, .segment, .edit-button, .focus-controls, .palette-search, .search-summary, .ring-empty, .submenu-empty-slot, .empty-prompt")) {
        void invoke("dismiss_palette");
      }
    });
    document.addEventListener("pointermove", previewTileReorder);
    document.addEventListener("pointerup", finishTileReorder);
    app.addEventListener("lostpointercapture", (event) => {
      if (event.target === app && tileReorder?.pointerId === event.pointerId) cancelTileReorder();
    });
    document.addEventListener("pointercancel", (event) => {
      if (tileReorder?.pointerId === event.pointerId) cancelTileReorder();
    });
    window.addEventListener("blur", () => {
      if (tileReorder?.pointerId != null) cancelTileReorder();
    });
    document.addEventListener("pointerleave", () => {
      if (!searchQuery.trim() && !tileReorder && !incomingTileKind && activeSubmenus.length && !(editing && selectedTileId)) {
        activeSubmenus = [];
        refreshSubmenus(1);
      }
    });
    document.addEventListener("dragover", (event) => {
      if (!incomingTileKind && !Array.from(event.dataTransfer?.types ?? []).includes("application/x-wayfinder-tile")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      previewDropAt(event.clientX, event.clientY);
    });
    document.addEventListener("drop", (event) => {
      if (externalDragging) return;
      const fallback = event.dataTransfer?.getData("text/plain") ?? "";
      const raw = event.dataTransfer?.getData("application/x-wayfinder-tile")
        || (fallback.startsWith("wayfinder-tile:") ? fallback.slice("wayfinder-tile:".length) : "");
      const kind = tileDefinitions.find((item) => item.kind === raw)?.kind ?? incomingTileKind;
      if (!kind) return;
      event.preventDefault();
      const target = dropTargetAt(event.clientX, event.clientY, kind);
      if (target) void finishTileDrop(kind, target);
      else clearDropTarget();
    });
    await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        if (event.payload.type === "enter" && event.payload.paths.length) {
          externalDragging = true;
          incomingTileKind = "folder";
          tileDropHandled = false;
          if (searchQuery) {
            resetPaletteSearch();
            render();
          }
        }
        if (incomingTileKind) previewDropAt(event.payload.position.x / window.devicePixelRatio, event.payload.position.y / window.devicePixelRatio);
      } else if (event.payload.type === "leave") {
        if (externalDragging) incomingTileKind = null;
        externalDragging = false;
        clearDropTarget();
      } else if (event.payload.type === "drop") {
        if (event.payload.paths.length) {
          const target = dropTargetAt(event.payload.position.x / window.devicePixelRatio, event.payload.position.y / window.devicePixelRatio);
          externalDragging = false;
          incomingTileKind = null;
          clearDropTarget();
          void addDroppedPaths(event.payload.paths, target);
        } else if (incomingTileKind) {
          const target = dropTargetAt(event.payload.position.x / window.devicePixelRatio, event.payload.position.y / window.devicePixelRatio);
          if (target) void finishTileDrop(incomingTileKind, target);
        }
      }
    });
    ready = true;
    await openPalette();
  } catch (error) {
    if (!app.querySelector(".stage")) render();
    await invoke("present_palette").catch(() => {});
    showToast(`Could not start palette: ${String(error)}`, true);
  }
}

document.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    if (searchQuery) {
      event.preventDefault();
      resetPaletteSearch();
      render("search");
      app.querySelector<HTMLInputElement>("#palette-search")?.focus({ preventScroll: true });
      return;
    }
    if (tileReorder?.started) {
      cancelTileReorder();
      return;
    }
    if (focusedSubmenuId !== null) {
      backFromFocus();
      return;
    }
    if (editing) {
      void invoke("set_edit_window_visible", { visible: false }).then(() => {
        editing = false;
        resetEditSelection();
        render();
      }).catch((error) => showToast(String(error), true));
    } else {
      void getCurrentWindow().close();
    }
  } else if (!isEditorWindow && !editing && !busy && !incomingTileKind && !event.defaultPrevented
    && !event.ctrlKey && !event.altKey && !event.metaKey && event.key !== " " && Array.from(event.key).length === 1) {
    const field = app.querySelector<HTMLInputElement>("#palette-search");
    if (!field || document.activeElement === field) return;
    event.preventDefault();
    field.value += event.key;
    field.dispatchEvent(new Event("input"));
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }
});

if (isEditorWindow) {
  document.body.classList.add("editor-window");
  void startEditor();
} else {
  void start();
}
