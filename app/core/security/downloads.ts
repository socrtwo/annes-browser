/** Download safety helpers. Server-supplied file names are untrusted input. */

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Make a server-supplied name safe to use as a file name inside the
 * downloads folder: no path components, no control characters, no names
 * that Windows treats specially, no hidden or empty names.
 */
export function sanitizeFilename(name: string, fallback = 'download'): string {
  let s = name.normalize('NFC');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '');
  s = s.split(/[\\/]/).at(-1) ?? '';
  s = s.replace(/[<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s.length > 200) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, 200 - ext.length) + ext;
  }
  if (s === '' || RESERVED.test(s)) return fallback;
  return s;
}

/** File types that run code when opened. They are never opened automatically. */
const DANGEROUS = new Set([
  'exe', 'msi', 'msp', 'scr', 'com', 'pif', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'cpl', 'dll', 'lnk', 'reg', 'jar', 'jnlp', 'app', 'command', 'dmg', 'pkg', 'sh', 'run', 'desktop', 'appimage',
  'deb', 'rpm', 'apk', 'iso', 'img', 'vhd', 'docm', 'xlsm', 'pptm', 'dotm', 'xlam', 'scf', 'url', 'chm',
]);

export function isDangerousFile(name: string): boolean {
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase();
  return ext !== undefined && DANGEROUS.has(ext);
}
