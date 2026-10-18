// Feature color is a pure function of the feature code. The fill is a small mix
// into the card color (about 8% in light, 10% in dark). The outline is a stronger
// hue that still clears non-text contrast, so the group reads as a tint rather
// than a saturated block.

export const INK_LIGHT = "#1c1915";
export const INK_DARK = "#ece7dc";
export const CARD_LIGHT = "#fffcf7";
export const CARD_DARK = "#1a212c";
export const SURFACE_LIGHT = "#e7e2d6";
export const SURFACE_DARK = "#151b24";

const TEXT_CONTRAST = 4.5;
const UI_CONTRAST = 3;
const LIGHT_MIX = 0.08;
const DARK_MIX = 0.1;

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

function mix(pigment: RGB, base: RGB, amount: number): RGB {
  return [
    pigment[0] * amount + base[0] * (1 - amount),
    pigment[1] * amount + base[1] * (1 - amount),
    pigment[2] * amount + base[2] * (1 - amount),
  ];
}

/** FNV-1a folded into a hue. The same code always returns the same hue. */
export function featureHue(code: string): number {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const n = h >>> 0;
  return Math.floor((n * 137.50776405003785) % 360);
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  const step = from <= to ? 1 : -1;
  for (let n = from; step > 0 ? n <= to : n >= to; n += step) out.push(n);
  return out;
}

function outline(hue: number, sat: number, against: string[], levels: number[]): string {
  let best = hslHex(hue, sat, levels[0] ?? 40);
  let bestScore = -1;
  for (const l of levels) {
    const hex = hslHex(hue, sat, l);
    const ratios = against.map((bg) => contrastRatio(hex, bg));
    const score = Math.min(...ratios);
    if (score >= UI_CONTRAST) return hex;
    if (score > bestScore) {
      best = hex;
      bestScore = score;
    }
  }
  return best;
}

function tone(hue: number, card: string, surface: string, dark: boolean): Tone {
  const pigment = hslRgb(hue, dark ? 46 : 52, dark ? 64 : 40);
  const bg = rgbHex(mix(pigment, hexRgb(card), dark ? DARK_MIX : LIGHT_MIX));
  const border = dark
    ? outline(hue, 48, [surface, bg], range(78, 58))
    : outline(hue, 58, [surface, bg], range(28, 46));
  return { bg, border };
}

export function featurePalette(code: string): FeaturePalette {
  const hue = featureHue(code);
  return {
    hue,
    light: tone(hue, CARD_LIGHT, SURFACE_LIGHT, false),
    dark: tone(hue, CARD_DARK, SURFACE_DARK, true),
  };
}

export function paletteStyle(p: FeaturePalette): string {
  return `--fg-bg:${p.light.bg};--fg-bd:${p.light.border};--fg-bg-dark:${p.dark.bg};--fg-bd-dark:${p.dark.border}`;
}
