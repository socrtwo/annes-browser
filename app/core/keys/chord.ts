/**
 * Key chords. A chord is one key press with modifiers ("Ctrl+Shift+T"); a
 * binding is a space-separated sequence of chords ("G G").
 *
 * Canonical form: modifiers in the order Ctrl, Alt, Shift, Meta, then the key.
 * Letters are upper case with an explicit Shift. Other printable characters
 * stand for the character produced, so they never carry Shift ("?" not
 * "Shift+/"), which keeps bindings independent of keyboard layout.
 */

export type OS = 'mac' | 'other';

const NAMED_KEYS = new Map<string, string>(
  [
    'Enter', 'Escape', 'Tab', 'Space', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
    'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Plus',
    'ContextMenu', 'PrintScreen', 'Pause',
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ].map((k) => [k.toLowerCase(), k]),
);
const KEY_ALIASES: Record<string, string> = {
  esc: 'Escape', return: 'Enter', del: 'Delete', ins: 'Insert', left: 'ArrowLeft', right: 'ArrowRight',
  up: 'ArrowUp', down: 'ArrowDown', pgup: 'PageUp', pgdn: 'PageDown', ' ': 'Space', '+': 'Plus',
};
const MODIFIER_ALIASES: Record<string, 'Ctrl' | 'Alt' | 'Shift' | 'Meta' | 'Mod'> = {
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', mod: 'Mod', cmdorctrl: 'Mod',
};

export class ChordSyntaxError extends Error {
  constructor(message: string) { super(message); this.name = 'ChordSyntaxError'; }
}

export interface Chord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

function canonicalKey(raw: string): string | undefined {
  const lower = raw.toLowerCase();
  const named = KEY_ALIASES[lower] ?? NAMED_KEYS.get(lower);
  if (named) return named;
  // One printable ASCII character. Anything else (dead keys, IME, media keys) is not bindable.
  if (raw.length === 1 && raw >= '!' && raw <= '~') return raw.toUpperCase();
  return undefined;
}

const isLetter = (key: string) => key.length === 1 && key >= 'A' && key <= 'Z';
const isPrintable = (key: string) => key.length === 1;

export function formatChord(c: Chord): string {
  const shift = c.shift && !(isPrintable(c.key) && !isLetter(c.key));
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', shift && 'Shift', c.meta && 'Meta', c.key].filter(Boolean).join('+');
}

/** Parse one chord as written in a keymap. `Mod` is Meta on macOS, Ctrl elsewhere. */
export function parseChord(text: string, os: OS): Chord {
  // The key itself may be "+", written as "Ctrl++" or "Plus".
  const parts = text === '+' ? ['+'] : text.endsWith('++') ? [...text.slice(0, -2).split('+'), '+'] : text.split('+');
  const keyPart = parts.pop();
  if (keyPart === undefined || keyPart === '') throw new ChordSyntaxError(`missing key in "${text}"`);
  const chord: Chord = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const part of parts) {
    const mod = MODIFIER_ALIASES[part.toLowerCase()];
    if (!mod) throw new ChordSyntaxError(`unknown modifier "${part}" in "${text}"`);
    const resolved = mod === 'Mod' ? (os === 'mac' ? 'Meta' : 'Ctrl') : mod;
    const field = resolved.toLowerCase() as 'ctrl' | 'alt' | 'shift' | 'meta';
    if (chord[field]) throw new ChordSyntaxError(`duplicate modifier "${part}" in "${text}"`);
    chord[field] = true;
  }
  const key = canonicalKey(keyPart);
  if (!key) throw new ChordSyntaxError(`unknown key "${keyPart}" in "${text}"`);
  chord.key = key;
  return chord;
}

/** Parse a binding ("Ctrl+K Ctrl+S") into canonical chord strings. */
export function parseSequence(text: string, os: OS): string[] {
  const chords = text.trim().split(/\s+/).filter(Boolean);
  if (chords.length === 0) throw new ChordSyntaxError('empty key sequence');
  if (chords.length > 4) throw new ChordSyntaxError(`sequence longer than 4 chords: "${text}"`);
  return chords.map((c) => formatChord(parseChord(c, os)));
}

/** The shape of Electron's `before-input-event` input and of a DOM KeyboardEvent. */
export interface KeyInput {
  key: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

/** Canonical chord for a key press, or undefined for modifier-only and unbindable keys. */
export function chordFromInput(input: KeyInput): string | undefined {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'CapsLock', 'Dead', 'Process', 'Unidentified'].includes(input.key)) {
    return undefined;
  }
  const key = canonicalKey(input.key);
  if (!key) return undefined;
  return formatChord({ ctrl: input.control, alt: input.alt, shift: input.shift, meta: input.meta, key });
}

/**
 * True if the chord could be ordinary typing: a printable key (or Space,
 * Enter, Backspace, Tab, Delete) with no Ctrl, Alt or Meta. Such chords may
 * only be bound in modal mode (enforced by the catalog build).
 */
export function isTypingChord(canonical: string): boolean {
  const parts = canonical.split('+');
  const key = canonical === '+' || canonical.endsWith('++') ? '+' : parts[parts.length - 1]!;
  const mods = new Set(parts.slice(0, -1));
  if (mods.has('Ctrl') || mods.has('Alt') || mods.has('Meta')) return false;
  return isPrintable(key) || ['Space', 'Enter', 'Backspace', 'Tab', 'Delete'].includes(key);
}

const ELECTRON_KEYS: Record<string, string> = {
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Escape: 'Esc',
};

/** Electron accelerator text for a canonical chord, used only to display shortcuts in menus. */
export function toAccelerator(canonical: string, os: OS): string {
  const parts = canonical.split('+');
  const key = parts.pop()!;
  const mods = parts.map((m) => (m === 'Meta' ? (os === 'mac' ? 'Cmd' : 'Super') : m));
  return [...mods, ELECTRON_KEYS[key] ?? key].join('+');
}
