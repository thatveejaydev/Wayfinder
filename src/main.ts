import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";

type Shortcut = {
  id: string;
  path: string;
  name: string;
  kind: "folder" | "image" | "pdf" | "video" | "audio" | "file" | "submenu" | "text" | "webpage" | "app";
  preview: string | null;
  text?: string | null;
  parentId?: string | null;
};

type TileKind = "submenu" | "text" | "folder" | "webpage" | "app";
type EditableTileKind = TileKind | "file";
type TileSelection = { item: Omit<Shortcut, "preview">; level: number };
type EditorTab = "tiles" | "edit-tile" | "appearance" | "theme" | "misc";
type InstalledApp = { name: string; path: string };
const tileDefinitions: { kind: TileKind; label: string; detail: string }[] = [
  { kind: "submenu", label: "Submenu", detail: "Open an outer ring of tiles" },
  { kind: "text", label: "Text", detail: "Copy a saved snippet" },
  { kind: "folder", label: "Folder", detail: "Open a folder in Explorer" },
  { kind: "webpage", label: "Webpage", detail: "Open a saved link" },
  { kind: "app", label: "App", detail: "Launch an app or shortcut" },
];

type ThemeMode = "light" | "dark" | "system";
type ThemeColor = "background" | "highlight" | "border";
type Theme = { mode: ThemeMode } & Record<ThemeColor, string | null>;

const themeColors: { key: ThemeColor; label: string; light: string; dark: string }[] = [
  { key: "background", label: "Palette background color", light: "#f0f2f5", dark: "#181818" },
  { key: "highlight", label: "Palette highlight color", light: "#90c7fb", dark: "#5ba9f2" },
  { key: "border", label: "Palette border color", light: "#a3aeb9", dark: "#3b3b3b" },
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
  theme: Theme;
  animations: boolean;
  openAtScreenCenter: boolean;
  castShadow: boolean;
};

type AppearanceKey = Exclude<keyof Appearance, "theme" | "animations" | "openAtScreenCenter" | "castShadow">;

const sliderDefinitions: { key: AppearanceKey; label: string; min: number; max: number; unit?: string }[] = [
  { key: "shellSize", label: "Tile size", min: 360, max: 760, unit: "px" },
  { key: "textSize", label: "Text size", min: 8, max: 18, unit: "px" },
  { key: "innerRadius", label: "Root shell inner radius", min: 60, max: 156, unit: "px" },
  { key: "borderThickness", label: "Border thickness", min: 0, max: 6, unit: "px" },
  { key: "tileCornerRadius", label: "Tile Corner radius", min: 0, max: 30, unit: "px" },
  { key: "tilePadding", label: "Tile padding", min: 0, max: 16, unit: "px" },
  { key: "submenuPadding", label: "Submenu padding", min: 0, max: 24, unit: "px" },
];

const app = document.querySelector<HTMLDivElement>("#app")!;
const isEditorWindow = new URLSearchParams(window.location.search).get("editor") === "1";
const SVG_NS = "http://www.w3.org/2000/svg";
const CENTER = 310;
const OUTER = 231;
const MAX_ITEMS = 12;

let shortcuts: Shortcut[] = [];
const shortcutIcons = new Map<string, Promise<string | null>>();
let editing = false;
let dragging = false;
let externalDragging = false;
let incomingTileKind: TileKind | null = null;
let incomingIndex: number | null = null;
let incomingParentId: string | null = null;
let activeSubmenus: string[] = [];
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
    case "submenu":
      return `<svg viewBox="0 0 48 48" aria-hidden="true"><path d="M14 10h10l13 14-13 14H14l13-14Z" fill="currentColor"/></svg>`;
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

function positionSegment(segment: SVGGElement, shape: string, angle: number) {
  for (const path of segment.children) path.setAttribute("d", shape);
  segment.style.setProperty("--submenu-angle", `${angle}deg`);
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

function shortcutName(item: Shortcut): string {
  return item.name || item.path.split(/[\\/]/).pop()?.replace(/\.(exe|lnk)$/i, "") || "App";
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

function ringSegmentPath(start: number, end: number, innerRadius: number, outerRadius: number): string {
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
  const sharpPath = `M ${ox1} ${oy1} A ${outerRadius} ${outerRadius} 0 0 1 ${oxm} ${oym} A ${outerRadius} ${outerRadius} 0 0 1 ${ox2} ${oy2} L ${ix2} ${iy2} A ${innerRadius} ${innerRadius} 0 0 0 ${ixm} ${iym} A ${innerRadius} ${innerRadius} 0 0 0 ${ix1} ${iy1} Z`;
  if (!appearance.tileCornerRadius) return sharpPath;

  const sideLength = Math.min(Math.hypot(ox1 - ix1, oy1 - iy1), Math.hypot(ox2 - ix2, oy2 - iy2));
  const corner = Math.min(
    appearance.tileCornerRadius,
    sideLength * 0.48,
    (outerEnd - outerStart) * Math.PI / 180 * outerRadius * 0.24,
    (innerEnd - innerStart) * Math.PI / 180 * innerRadius * 0.24,
  );
  if (corner <= 0) return sharpPath;
  const outerAngle = corner / outerRadius * 180 / Math.PI;
  const innerAngle = corner / innerRadius * 180 / Math.PI;
  const [outerArcStartX, outerArcStartY] = point(outerRadius, outerStart + outerAngle);
  const [outerArcMiddleX, outerArcMiddleY] = point(outerRadius, (outerStart + outerEnd) / 2);
  const [outerArcEndX, outerArcEndY] = point(outerRadius, outerEnd - outerAngle);
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
  return `M ${outerArcStartX} ${outerArcStartY} A ${outerRadius} ${outerRadius} 0 0 1 ${outerArcMiddleX} ${outerArcMiddleY} A ${outerRadius} ${outerRadius} 0 0 1 ${outerArcEndX} ${outerArcEndY} Q ${ox2} ${oy2} ${outerEndSideX} ${outerEndSideY} L ${innerEndSideX} ${innerEndSideY} Q ${ix2} ${iy2} ${innerArcEndX} ${innerArcEndY} A ${innerRadius} ${innerRadius} 0 0 0 ${innerArcMiddleX} ${innerArcMiddleY} A ${innerRadius} ${innerRadius} 0 0 0 ${innerArcStartX} ${innerArcStartY} Q ${ix1} ${iy1} ${innerStartSideX} ${innerStartSideY} L ${outerStartSideX} ${outerStartSideY} Q ${ox1} ${oy1} ${outerArcStartX} ${outerArcStartY} Z`;
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
  const roots = childrenOf(null);
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
  if (tileReorder) return;
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
  const roots = childrenOf(null);
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
    if (level < 2 && items.length) {
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
    if (level === 2 && kind === "submenu") return null;
    const index = fanInsertionIndex(level, center, items.length, angle);
    return index === null ? null : { parentId, index };
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
  const placeholder = app.querySelector<SVGPathElement>(".root-drop-indicator");
  if (!placeholder) return;
  const roots = childrenOf(null);
  const active = incomingTileKind !== null && incomingParentId === null && incomingIndex !== null && roots.length < MAX_ITEMS;
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
  const paths = Array.from(app.querySelectorAll<SVGGElement>(".ring-segments .segment"));
  const buttons = Array.from(app.querySelectorAll<HTMLButtonElement>('.item-layer .shortcut[data-level="0"]'));
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

  window.cancelAnimationFrame(layoutAnimation);
  const paint = (angles: [number, number][]) => {
    angles.forEach(([start, end], index) => {
      const middle = (start + end) / 2;
      if (paths[index]) positionSegment(paths[index], segmentPath(start, end), middle);
      if (buttons[index]) positionTile(buttons[index], (OUTER + appearance.innerRadius) / 2, middle);
    });
    displayedAngles = angles;
  };
  const from = displayedAngles.length === target.length ? displayedAngles.map(([start, end]) => [start, end] as [number, number]) : target;
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
      if (paths[index]) positionSegment(paths[index], ringSegmentPath(start, end, ring.inner, ring.outer), middle);
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
    if (kind === "submenu") {
      await invoke("create_tile", { kind, name: "Submenu", value: "", index: target.index, parentId: target.parentId });
      shortcuts = await invoke<Shortcut[]>("list_shortcuts");
      render();
    } else {
      await invoke("open_tile_form", { kind, index: target.index, parentId: target.parentId });
    }
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
) {
  const path = document.createElementNS(SVG_NS, "g");
  const hitArea = document.createElementNS(SVG_NS, "path");
  hitArea.classList.add("segment-hit-area");
  const surface = document.createElementNS(SVG_NS, "path");
  surface.classList.add("segment-surface");
  path.append(hitArea, surface);
  positionSegment(path, ringSegmentPath(start, end, innerRadius, outerRadius), middle);
  path.setAttribute("class", "segment");
  path.dataset.level = String(level);
  if (activeSubmenus.includes(item.id)) path.classList.add("active-submenu");
  path.dataset.id = item.id;
  const selected = editing && selectedTileId === item.id;
  path.classList.toggle("selected-tile", selected);
  path.addEventListener("click", (event) => activate(item, level, event.shiftKey));
  segments.appendChild(path);

  const button = document.createElement("button");
  button.className = `shortcut${level ? ` child-shortcut level-${level}` : ""}`;
  button.classList.toggle("single-content", item.kind === "text" || item.kind === "submenu" || !item.name);
  button.classList.toggle("active-submenu", activeSubmenus.includes(item.id));
  button.dataset.id = item.id;
  button.dataset.level = String(level);
  button.type = "button";
  positionTile(button, (innerRadius + outerRadius) / 2, middle);
  const name = shortcutName(item);
  const action = editing ? "Edit" : item.kind === "text" ? "Copy" : "Open";
  button.setAttribute("aria-label", `${action} ${name}`);
  if (editing) button.setAttribute("aria-pressed", String(selected));
  button.title = `${action} ${name}`;
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
  button.innerHTML = `${tileIcon}${item.name ? '<span class="shortcut-label"></span>' : ""}${editing ? '<span class="remove-badge">×</span>' : ""}`;
  if (!item.preview && (item.kind === "app" || item.kind === "webpage")) {
    loadShortcutIcon(item, button.querySelector<HTMLElement>(".shortcut-icon")!);
  }
  const label = button.querySelector<HTMLElement>(".shortcut-label");
  if (label) label.textContent = item.name;
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

function render(animateOpening = false) {
  const animate = appearance.animations && animateOpening;
  cancelTileReorder(false);
  const roots = childrenOf(null);
  window.cancelAnimationFrame(layoutAnimation);
  childLayoutAnimations.forEach((animation) => window.cancelAnimationFrame(animation));
  childLayoutAnimations = [0, 0, 0];
  displayedChildAngles = [[], [], []];
  displayedAngles = roots.map((_, index) => {
    const [start, end] = segmentAngles(index, roots.length);
    return [start, end];
  });
  app.style.setProperty("--tile-size", `${appearance.shellSize}px`);
  app.style.setProperty("--content-scale", `${Math.min(1, appearance.shellSize / 620)}`);
  app.style.setProperty("--text-size", `${appearance.textSize}px`);
  app.style.setProperty("--border-thickness", `${appearance.borderThickness}px`);
  const emptyRadius = (OUTER + appearance.innerRadius) / 2;
  const emptyWidth = OUTER - appearance.innerRadius;
  app.innerHTML = `
    <main class="stage ${dragging ? "is-dragging" : ""} ${editing ? "is-editing" : ""}">
      <div class="palette" aria-label="Radial shortcut palette">
        <svg class="ring-svg" viewBox="0 0 620 620" aria-hidden="true">
          ${roots.length ? "" : `<circle class="ring-empty" cx="310" cy="310" r="${emptyRadius}" stroke-width="${emptyWidth}" />`}
          <g class="ring-segments"></g>
          <g class="child-segments"></g>
          <path class="root-drop-indicator drop-indicator" />
        </svg>
        <div class="item-layer"></div>
        <button class="edit-button" type="button" aria-label="${editing ? "Finish editing" : "Edit shortcuts"}" title="${editing ? "Done editing" : "Edit shortcuts"}" aria-pressed="${editing}">
          <svg viewBox="0 0 24 24" aria-hidden="true">${editing
            ? '<path d="m9.2 16.3-4.5-4.5-1.7 1.7 6.2 6.2L21 7.9l-1.7-1.7z"/>'
            : `<path d="M10 2h4l.5 3 1.5.9 2.8-1.1 2 3.4-2.3 1.9v1.8l2.3 1.9-2 3.4-2.8-1.1-1.5.9-.5 3h-4l-.5-3-1.5-.9-2.8 1.1-2-3.4 2.3-1.9v-1.8L3.2 8.2l2-3.4L8 5.9 9.5 5 10 2Zm2 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" fill-rule="evenodd" transform="translate(0 1)"/>`}</svg>
        </button>
        ${!roots.length ? '<div class="empty-prompt"><span class="drop-arrow">↓</span><span>DRAG & DROP<br/>NEW ITEMS HERE</span></div>' : ""}
        <div class="toast" role="status" aria-live="polite"></div>
      </div>
    </main>
  `;

  const segments = document.querySelector<SVGGElement>(".ring-segments")!;
  const childSegments = document.querySelector<SVGGElement>(".child-segments")!;
  const layer = document.querySelector<HTMLDivElement>(".item-layer")!;

  roots.forEach((item, index) => {
    const [start, end, middle] = segmentAngles(index, roots.length);
    appendTile(item, 0, start, end, middle, appearance.innerRadius, OUTER, segments, layer,
      animate ? { index, count: roots.length } : undefined);
  });
  if (animate && !roots.length) {
    app.querySelector(".ring-empty")?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 145, easing: "ease-out" });
  }
  if (activeSubmenus[0]) renderChildRing(activeSubmenus[0], 1, childSegments, layer, false);
  if (activeSubmenus[1]) renderChildRing(activeSubmenus[1], 2, childSegments, layer, false);

  document.querySelector<HTMLButtonElement>(".edit-button")!.addEventListener("click", async () => {
    const nextEditing = !editing;
    try {
      await invoke("set_edit_window_visible", { visible: nextEditing });
      editing = nextEditing;
      if (!editing) resetEditSelection();
      render();
    } catch (error) {
      showToast(String(error), true);
    }
  });
  updateDropIndicator(false);
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

async function activate(item: Shortcut, level: number, shiftKey: boolean) {
  if (editing) {
    if (busy) return;
    selectedTileId = item.id;
    if (item.kind !== "submenu") activeSubmenus = activeSubmenus.slice(0, level);
    if (!openSubmenu(item, level)) render();
    const { id, name, kind, path, text } = item;
    await emitTo("editor", "tile-selection-changed", { item: { id, name, kind, path, text }, level })
      .catch((error) => showToast(String(error), true));
    return;
  }
  if (item.kind === "submenu") {
    openSubmenu(item, level);
    return;
  }
  if (busy) return;
  busy = true;
  try {
    await invoke("dismiss_palette");
    activeSubmenus = [];
    render();
    await invoke("open_shortcut", { id: item.id, inTerminal: item.kind === "folder" && shiftKey });
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
  const parentId = target?.parentId ?? null;
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
    ${kind === "app" ? `<label for="${id}-apps">Installed apps</label><select id="${id}-apps" class="installed-apps" size="4"><option value="">Loading apps…</option></select>` : ""}
    <label for="${id}">${label}</label>
    <div class="tile-path-row">
      <input id="${id}" name="value" type="text" required spellcheck="false" placeholder="${kind === "webpage" ? "https://example.com" : "Choose or paste a path"}" />
      ${kind !== "webpage" ? '<button class="tile-browse" type="button">Browse</button>' : ""}
    </div>`;
}

function bindTileValueFields(form: HTMLFormElement, fields: HTMLElement, kind: EditableTileKind, fillAppName: boolean) {
  const value = fields.querySelector<HTMLInputElement | HTMLTextAreaElement>('[name="value"]');
  const appSelect = fields.querySelector<HTMLSelectElement>(".installed-apps");
  if (appSelect && value) {
    void invoke<InstalledApp[]>("list_installed_apps").then((items) => {
      appSelect.replaceChildren(new Option(items.length ? "Choose an installed app" : "No Start Menu apps found; browse or paste a path", ""));
      items.forEach((item) => appSelect.add(new Option(item.name, item.path)));
      appSelect.value = items.some((item) => item.path === value.value) ? value.value : "";
      appSelect.addEventListener("change", () => {
        const selected = items.find((item) => item.path === appSelect.value);
        if (!selected) return;
        value.value = selected.path;
        const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
        if (fillAppName && !name.value.trim()) name.value = selected.name;
      });
    }).catch(() => {
      appSelect.replaceChildren(new Option("Browse or paste an app path", ""));
    });
  }
  fields.querySelector<HTMLButtonElement>(".tile-browse")?.addEventListener("click", async () => {
    try {
      const path = await invoke<string | null>("pick_tile_path", { kind });
      if (path && value?.isConnected) value.value = path;
    } catch (error) {
      form.querySelector<HTMLElement>(".tile-form-error")!.textContent = String(error);
    }
  });
  return value;
}

function editableKind(kind: Shortcut["kind"]): EditableTileKind {
  return tileDefinitions.find((definition) => definition.kind === kind)?.kind ?? "file";
}

function selectedTileForm(selection: TileSelection) {
  const types = [...tileDefinitions, { kind: "file", label: "File" }];
  return `
    <form id="tile-edit-form" class="tile-form tile-edit-form" aria-label="Selected tile">
      <h2>Selected tile</h2>
      <label for="edit-tile-kind">Type</label>
      <select id="edit-tile-kind" name="kind">
        ${types.filter(({ kind }) => kind !== "submenu" || selection.level < 2).map(({ kind, label }) => `<option value="${kind}">${label}</option>`).join("")}
      </select>
      <label for="edit-tile-name">Name</label>
      <input id="edit-tile-name" name="name" type="text" maxlength="80" autocomplete="off" />
      <div class="tile-fields"></div>
      <div class="tile-form-error" role="alert"></div>
      <div class="tile-form-actions"><button class="tile-save" type="submit">Save changes</button></div>
    </form>`;
}

function bindSelectedTileForm(form: HTMLFormElement, selection: TileSelection) {
  const type = form.querySelector<HTMLSelectElement>('[name="kind"]')!;
  const name = form.querySelector<HTMLInputElement>('[name="name"]')!;
  const fields = form.querySelector<HTMLElement>(".tile-fields")!;
  const error = form.querySelector<HTMLElement>(".tile-form-error")!;
  const save = form.querySelector<HTMLButtonElement>(".tile-save")!;
  const { item } = selection;
  let kind = editableKind(item.kind);
  const values = new Map<EditableTileKind, string>([[kind, kind === "text" ? item.text ?? "" : item.path]]);
  let value: HTMLInputElement | HTMLTextAreaElement | null;
  const renderFields = () => {
    name.placeholder = kind === "app" ? "Leave blank for icon only" : "Optional name";
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
    const details = { id: item.id, kind, name: name.value, value: value?.value ?? "" };
    const controls = form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>("input, textarea, select, button");
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

function renderEditor() {
  app.innerHTML = `
    <section class="settings" aria-label="Palette settings">
      <header class="settings-header">
        <h1>Palette settings</h1>
        <p>Add shortcuts and adjust the floating palette.</p>
      </header>
      <div class="settings-tabs" role="tablist" aria-label="Settings sections">
        <button class="settings-tab ${editorTab === "tiles" ? "active" : ""}" data-tab="tiles" type="button" role="tab" aria-selected="${editorTab === "tiles"}" aria-controls="tiles-panel">Tiles</button>
        <button class="settings-tab ${editorTab === "edit-tile" ? "active" : ""}" data-tab="edit-tile" type="button" role="tab" aria-selected="${editorTab === "edit-tile"}" aria-controls="edit-tile-panel">Edit Tile</button>
        <button class="settings-tab ${editorTab === "appearance" ? "active" : ""}" data-tab="appearance" type="button" role="tab" aria-selected="${editorTab === "appearance"}" aria-controls="appearance-panel">Appearance</button>
        <button class="settings-tab ${editorTab === "theme" ? "active" : ""}" data-tab="theme" type="button" role="tab" aria-selected="${editorTab === "theme"}" aria-controls="theme-panel">Theme</button>
        <button class="settings-tab ${editorTab === "misc" ? "active" : ""}" data-tab="misc" type="button" role="tab" aria-selected="${editorTab === "misc"}" aria-controls="misc-panel">Misc</button>
      </div>
      ${editorTab === "tiles" ? `<div class="tiles-panel" id="tiles-panel" role="tabpanel" aria-label="Tiles">
        <p class="tiles-instruction">Drag a tile onto the palette, or click a tile type to add it at the end.</p>
        <div class="tile-sources">${tileDefinitions.map(({ kind, label, detail }) => `
          <button class="tile-source" type="button" draggable="true" data-kind="${kind}" aria-label="Add ${label}">
            <span class="tile-source-icon">${icon(kind)}</span>
            <span class="tile-source-copy"><strong>${label}</strong><small>${detail}</small></span>
            <span class="tile-source-grip" aria-hidden="true">⋮⋮</span>
          </button>
        `).join("")}</div>
      </div>` : editorTab === "edit-tile" ? `<div id="edit-tile-panel" role="tabpanel" aria-label="Edit Tile">
        ${selectedTile ? selectedTileForm(selectedTile) : '<p class="tiles-instruction">Select a tile on the palette to edit it.</p>'}
      </div>` : editorTab === "appearance" ? `<div class="appearance-panel" id="appearance-panel" role="tabpanel" aria-label="Appearance">
        ${sliderDefinitions.map(({ key, label, min, max, unit }) => `
          <div class="setting-row">
            <label for="setting-${key}">${label} <span class="setting-value" data-value="${key}">(${appearance[key]}${unit ?? ""})</span></label>
            <input id="setting-${key}" data-key="${key}" type="range" min="${min}" max="${max}" value="${appearance[key]}" />
          </div>
        `).join("")}
        <p class="setting-note">Submenu padding adjusts the space between rings.</p>
      </div>` : editorTab === "theme" ? `<div class="theme-panel" id="theme-panel" role="tabpanel" aria-label="Theme">
        <div class="setting-row">
          <label for="theme-mode">Mode</label>
          <select id="theme-mode">
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </div>
        ${themeColors.map(({ key, label }) => `
          <div class="setting-row">
            <label for="theme-${key}">${label}</label>
            <input id="theme-${key}" type="color" />
          </div>
        `).join("")}
      </div>` : `<div id="misc-panel" role="tabpanel" aria-label="Misc">
        <div class="setting-row">
          <label for="palette-hotkey">Open palette hotkey</label>
          <input id="palette-hotkey" type="text" readonly placeholder="Press a shortcut" aria-describedby="hotkey-note" />
        </div>
        <p class="setting-note hotkey-note" id="hotkey-note">Press a key combination, or hold a modifier and click this field.</p>
        <div class="setting-row">
          <label for="palette-animations">Enable animations</label>
          <input id="palette-animations" type="checkbox" ${appearance.animations ? "checked" : ""} />
        </div>
        <div class="setting-row">
          <label for="palette-screen-center">Open at screen center</label>
          <input id="palette-screen-center" type="checkbox" ${appearance.openAtScreenCenter ? "checked" : ""} />
        </div>
        <div class="setting-row">
          <label for="palette-cast-shadow">Cast shadow</label>
          <input id="palette-cast-shadow" type="checkbox" ${appearance.castShadow ? "checked" : ""} />
        </div>
      </div>`}
      <div class="settings-status" role="status" aria-live="polite"></div>
    </section>
    ${tileForm ? `<div class="form-backdrop">
      <form id="tile-create-form" class="tile-form" aria-label="Add ${tileForm.kind} tile">
        <h2>Add ${tileDefinitions.find((item) => item.kind === tileForm!.kind)!.label}</h2>
        <p>Slot ${tileForm.index + 1} ${tileForm.parentId ? "in the submenu" : "on the root ring"}</p>
        <label for="tile-name">Name</label>
        <input id="tile-name" name="name" type="text" maxlength="80" placeholder="${tileForm.kind === "app" ? "Leave blank for icon only" : "Optional name"}" autocomplete="off" />
        <div class="tile-fields">${tileValueFields(tileForm.kind, "tile-value")}</div>
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
  const mode = app.querySelector<HTMLSelectElement>("#theme-mode");
  if (mode) {
    mode.value = appearance.theme.mode;
    mode.addEventListener("change", () => {
      appearance.theme.mode = mode.value as ThemeMode;
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

  app.querySelectorAll<HTMLButtonElement>(".settings-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      editorTab = tab.dataset.tab as EditorTab;
      renderEditor();
      app.scrollTop = 0;
    });
  });

  app.querySelectorAll<HTMLButtonElement>(".tile-source").forEach((source) => {
    const kind = source.dataset.kind as TileKind;
    source.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("application/x-radial-tile", kind);
      event.dataTransfer?.setData("text/plain", `radial-tile:${kind}`);
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
        if (kind === "submenu") {
          await invoke("create_tile", { kind, name: "Submenu", value: "", index: rootCount, parentId: null });
          const status = app.querySelector<HTMLElement>(".settings-status");
          if (status) status.textContent = "Submenu tile added";
        } else {
          openTileForm(kind, rootCount, null);
        }
      } catch (error) {
        const status = app.querySelector<HTMLElement>(".settings-status");
        if (status) status.textContent = String(error);
      }
    });
  });

  app.querySelectorAll<HTMLInputElement>("input[type=range]").forEach((input) => {
    const definition = sliderDefinitions.find((item) => item.key === input.dataset.key)!;
    const update = () => {
      const value = Number(input.value);
      appearance[definition.key] = value;
      app.querySelector<HTMLElement>(`[data-value="${definition.key}"]`)!.textContent = `(${value}${definition.unit ?? ""})`;
      input.style.setProperty("--progress", `${(value - definition.min) / (definition.max - definition.min) * 100}%`);
      previewAppearance();
      scheduleAppearanceSave();
    };
    input.style.setProperty("--progress", `${(Number(input.value) - definition.min) / (definition.max - definition.min) * 100}%`);
    input.addEventListener("input", update);
    input.addEventListener("change", () => scheduleAppearanceSave(true));
  });

  const editForm = app.querySelector<HTMLFormElement>("#tile-edit-form");
  if (editForm && selectedTile) bindSelectedTileForm(editForm, selectedTile);
  const form = app.querySelector<HTMLFormElement>("#tile-create-form");
  if (form && tileForm) {
    const valueField = bindTileValueFields(form, form.querySelector<HTMLElement>(".tile-fields")!, tileForm.kind, true);
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
      const name = form.querySelector<HTMLInputElement>("#tile-name")!.value;
      const value = valueField?.value ?? "";
      try {
        await invoke("create_tile", { kind: current.kind, name, value, index: current.index, parentId: current.parentId });
        tileForm = null;
        renderEditor();
        app.querySelector<HTMLElement>(".settings-status")!.textContent = "Tile added";
      } catch (error) {
        form.querySelector<HTMLElement>(".tile-form-error")!.textContent = String(error);
        save.disabled = false;
      }
    });
    valueField?.focus();
  }
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
  } catch (error) {
    app.textContent = `Could not load appearance settings: ${String(error)}`;
  }
}

let openingPalette = false;

async function openPalette() {
  if (openingPalette) return;
  openingPalette = true;
  try {
    activeSubmenus = [];
    render(true);
    const entrance = app.getAnimations({ subtree: true });
    for (const animation of entrance) {
      animation.pause();
      animation.currentTime = 0;
    }
    // Resolve the entrance styles before making the native window visible.
    app.getBoundingClientRect();
    await invoke("present_palette");
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
      if (dragging) {
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
      if (!target.closest(".shortcut, .segment, .edit-button, .ring-empty, .submenu-empty-slot, .empty-prompt")) {
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
      if (!tileReorder && !incomingTileKind && activeSubmenus.length && !(editing && selectedTileId)) {
        activeSubmenus = [];
        refreshSubmenus(1);
      }
    });
    document.addEventListener("dragover", (event) => {
      if (!incomingTileKind && !Array.from(event.dataTransfer?.types ?? []).includes("application/x-radial-tile")) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      previewDropAt(event.clientX, event.clientY);
    });
    document.addEventListener("drop", (event) => {
      if (externalDragging) return;
      const fallback = event.dataTransfer?.getData("text/plain") ?? "";
      const raw = event.dataTransfer?.getData("application/x-radial-tile")
        || (fallback.startsWith("radial-tile:") ? fallback.slice("radial-tile:".length) : "");
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
  if (event.key === "Escape") {
    if (tileReorder?.started) {
      cancelTileReorder();
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
  }
});

if (isEditorWindow) {
  document.body.classList.add("editor-window");
  void startEditor();
} else {
  void start();
}
