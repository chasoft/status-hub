// Feature tints are a pure function of the feature code so a code keeps one color
// across reloads, columns, and the table. Lightness is walked until text and the
// outline clear WCAG contrast against the theme ink and the column surface.

export const INK_LIGHT = "#1d2733";
export const INK_DARK = "#e7eef6";
export const SURFACE_LIGHT = "#eef1f4";
export const SURFACE_DARK = "#161e27";

const TEXT_CONTRAST = 4.5;
const UI_CONTRAST = 3;

export interface Tone {
  bg: string;
  border: string;
}

export interface FeaturePalette {
  hue: number;
  light: Tone;
  dark: Tone;
}

type RGB = [number, number, number];

function hexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
}

function rgbHex([r, g, b]: RGB): string {
  return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
}

function hexRgb(hex: string): RGB {
  const n = hex.slice(1);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function channel(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: RGB): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

/** WCAG contrast ratio for two #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
  const l1 = luminance(hexRgb(a));
  const l2 = luminance(hexRgb(b));
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function hslRgb(h: number, s: number, l: number): RGB {
  const S = s / 100;
  const L = l / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function hslHex(h: number, s: number, l: number): string {
  return rgbHex(hslRgb(h, s, l));
}

/** FNV-1a folded into a hue. The same code always returns the same hue. */
export function featureHue(code: string): number {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Golden angle spreads codes that hash close together onto different hues.
  const n = h >>> 0;
  return Math.floor((n * 137.50776405003785) % 360);
}

function firstPassing(hue: number, sat: number, against: string, levels: number[], minimum: number): string {
  let last = hslHex(hue, sat, levels[levels.length - 1] ?? 50);
  for (const l of levels) {
    const hex = hslHex(hue, sat, l);
    last = hex;
    if (contrastRatio(hex, against) >= minimum) return hex;
  }
  return last;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  const step = from <= to ? 1 : -1;
  for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(n);
  return out;
}

function tone(hue: number, ink: string, surface: string, dark: boolean): Tone {
  // Light theme: strongest pastel whose text still clears AA. Dark theme: lightest
  // tint that still clears AA against the light ink, so the hue stays visible.
  const bg = dark
    ? firstPassing(hue, 42, ink, range(36, 14), TEXT_CONTRAST)
    : firstPassing(hue, 52, ink, range(78, 96), TEXT_CONTRAST);
  let border = dark
    ? firstPassing(hue, 70, surface, range(58, 82), UI_CONTRAST)
    : firstPassing(hue, 65, surface, range(46, 24), UI_CONTRAST);
  const borderLevels = dark ? range(58, 88) : range(46, 16);
  if (contrastRatio(border, bg) < UI_CONTRAST) {
    border = firstPassing(hue, dark ? 70 : 65, bg, borderLevels, UI_CONTRAST);
  }
  return { bg, border };
}

export function featurePalette(code: string): FeaturePalette {
  const hue = featureHue(code);
  return {
    hue,
    light: tone(hue, INK_LIGHT, SURFACE_LIGHT, false),
    dark: tone(hue, INK_DARK, SURFACE_DARK, true),
  };
}

export function paletteStyle(p: FeaturePalette): string {
  return `--fg-bg:${p.light.bg};--fg-bd:${p.light.border};--fg-bg-dark:${p.dark.bg};--fg-bd-dark:${p.dark.border}`;
}
