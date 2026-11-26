/**
 * Web permission policy. Default deny: a permission is granted only if it is
 * listed here as `allow`, or listed as `ask` and the user said yes for that
 * origin. With no prompt UI connected, `ask` resolves to deny.
 */

export type PermissionRule = 'allow' | 'ask' | 'deny';

const RULES: Readonly<Record<string, PermissionRule>> = {
  fullscreen: 'allow',
  'clipboard-sanitized-write': 'allow',
  media: 'ask',
  geolocation: 'ask',
  notifications: 'ask',
  'clipboard-read': 'ask',
  'display-capture': 'ask',
  midi: 'ask',
  pointerLock: 'ask',
  keyboardLock: 'ask',
  mediaKeySystem: 'ask',
  'storage-access': 'ask',
  'top-level-storage-access': 'ask',
  'window-management': 'ask',
  'idle-detection': 'ask',
  'speaker-selection': 'ask',
  fileSystem: 'ask',
  // Direct hardware access and anything unrecognized are never granted.
  midiSysex: 'deny',
  hid: 'deny',
  serial: 'deny',
  usb: 'deny',
  // Launching other applications goes through the navigation policy instead.
  openExternal: 'deny',
};

/**
 * Rule for a permission. A permission may carry a qualifier after a colon
 * (`media:audio,video`), so that allowing the microphone does not also
 * allow the camera; the rule comes from the part before the colon.
 */
export function permissionRule(permission: string): PermissionRule {
  const base = permission.split(':', 1)[0]!;
  return Object.hasOwn(RULES, base) ? RULES[base]! : 'deny';
}

/** The qualified permission name for a media request. */
export function mediaPermission(mediaTypes: readonly string[] | undefined): string {
  const types = [...new Set((mediaTypes ?? []).filter((t) => t === 'audio' || t === 'video'))].sort();
  return types.length === 0 ? 'media' : `media:${types.join(',')}`;
}

const LABELS: Readonly<Record<string, string>> = {
  'media:audio': 'use your microphone',
  'media:video': 'use your camera',
  'media:audio,video': 'use your camera and microphone',
  media: 'use your camera or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  'display-capture': 'see your screen',
  midi: 'use your MIDI devices',
  pointerLock: 'hide and lock your mouse pointer',
  keyboardLock: 'capture all keyboard keys',
  mediaKeySystem: 'play protected content',
  'storage-access': 'use cookies it has stored as a third party',
  'top-level-storage-access': 'use cookies it has stored as a third party',
  'window-management': 'manage windows on all your displays',
  'idle-detection': 'know when you are using your device',
  'speaker-selection': 'choose your audio output device',
  fileSystem: 'edit files on your device',
};

/** Plain-language description for a permission prompt: "<origin> wants to <label>". */
export function permissionLabel(permission: string): string {
  return Object.hasOwn(LABELS, permission) ? LABELS[permission]! : `use "${permission.slice(0, 40)}"`;
}

/** Origins that may be asked about at all: HTTPS, and plain HTTP only on this machine. */
export function isPromptableOrigin(origin: string): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

/**
 * Asks the user. `context` identifies where the request came from (on
 * desktop, the tab), so the prompt can be shown in the right window.
 */
export type PermissionPrompt<C> = (origin: string, permission: string, context: C) => Promise<boolean>;

export class PermissionPolicy<C = undefined> {
  /** Remembered answers for this session, keyed by origin and permission. */
  private readonly decisions = new Map<string, boolean>();
  /** Requests waiting for an answer, so a page asking twice gets one prompt. */
  private readonly inFlight = new Map<string, Promise<boolean>>();
  private prompt: PermissionPrompt<C> | undefined;

  constructor(prompt?: PermissionPrompt<C>) {
    this.prompt = prompt;
  }

  setPrompt(prompt: PermissionPrompt<C>): void {
    this.prompt = prompt;
  }

  /** Permissions the user allowed for an origin this session. */
  granted(origin: string): string[] {
    let o: string;
    try { o = new URL(origin).origin; } catch { return []; }
    const prefix = `${o} `;
    return [...this.decisions].filter(([k, v]) => v && k.startsWith(prefix)).map(([k]) => k.slice(prefix.length)).sort();
  }

  /** Synchronous check, used for permission queries: true only if already granted. */
  check(origin: string, permission: string): boolean {
    const rule = permissionRule(permission);
    if (rule === 'allow') return true;
    if (rule === 'deny' || !isPromptableOrigin(origin)) return false;
    return this.decisions.get(key(origin, permission)) === true;
  }

  async request(origin: string, permission: string, context: C): Promise<boolean> {
    const rule = permissionRule(permission);
    if (rule === 'allow') return true;
    if (rule === 'deny' || !isPromptableOrigin(origin)) return false;
    const k = key(origin, permission);
    const known = this.decisions.get(k);
    if (known !== undefined) return known;
    const pending = this.inFlight.get(k);
    if (pending) return pending;
    const prompt = this.prompt;
    if (!prompt) return false;
    const ask = (async () => {
      try {
        const answer = (await prompt(new URL(origin).origin, permission, context)) === true;
        this.decisions.set(k, answer);
        return answer;
      } catch {
        return false;
      } finally {
        this.inFlight.delete(k);
      }
    })();
    this.inFlight.set(k, ask);
    return ask;
  }

  forget(origin?: string): void {
    if (origin === undefined) return this.decisions.clear();
    const prefix = `${new URL(origin).origin} `;
    for (const k of this.decisions.keys()) if (k.startsWith(prefix)) this.decisions.delete(k);
  }
}

const key = (origin: string, permission: string) => `${new URL(origin).origin} ${permission}`;
