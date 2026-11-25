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

export function permissionRule(permission: string): PermissionRule {
  return Object.hasOwn(RULES, permission) ? RULES[permission]! : 'deny';
}

/** Origins that may be asked about at all: HTTPS, and plain HTTP only on this machine. */
export function isPromptableOrigin(origin: string): boolean {
  let u: URL;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

export type PermissionPrompt = (origin: string, permission: string) => Promise<boolean>;

export class PermissionPolicy {
  /** Remembered answers for this session, keyed by origin and permission. */
  private readonly decisions = new Map<string, boolean>();

  private prompt: PermissionPrompt | undefined;

  constructor(prompt?: PermissionPrompt) {
    this.prompt = prompt;
  }

  setPrompt(prompt: PermissionPrompt): void {
    this.prompt = prompt;
  }

  /** Synchronous check, used for permission queries: true only if already granted. */
  check(origin: string, permission: string): boolean {
    const rule = permissionRule(permission);
    if (rule === 'allow') return true;
    if (rule === 'deny' || !isPromptableOrigin(origin)) return false;
    return this.decisions.get(key(origin, permission)) === true;
  }

  async request(origin: string, permission: string): Promise<boolean> {
    const rule = permissionRule(permission);
    if (rule === 'allow') return true;
    if (rule === 'deny' || !isPromptableOrigin(origin)) return false;
    const k = key(origin, permission);
    const known = this.decisions.get(k);
    if (known !== undefined) return known;
    if (!this.prompt) return false;
    const answer = (await this.prompt(new URL(origin).origin, permission)) === true;
    this.decisions.set(k, answer);
    return answer;
  }

  forget(origin?: string): void {
    if (origin === undefined) return this.decisions.clear();
    const prefix = `${new URL(origin).origin} `;
    for (const k of this.decisions.keys()) if (k.startsWith(prefix)) this.decisions.delete(k);
  }
}

const key = (origin: string, permission: string) => `${new URL(origin).origin} ${permission}`;
