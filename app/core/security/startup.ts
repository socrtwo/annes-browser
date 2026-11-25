/**
 * Command-line switches that would turn a release build into a remotely
 * controllable or unsandboxed one. A packaged build refuses to start with any
 * of them. (Release packaging also disables most of these at build time
 * through Electron fuses; this is the second layer.)
 */
export function hasUnsafeSwitches(argv: readonly string[]): string | undefined {
  return argv.find((a) =>
    /^--(remote-debugging-(port|pipe|address)|remote-allow-origins|inspect(-brk|-port|-publish-uid)?|no-sandbox|disable-web-security|disable-site-isolation-trials|allow-running-insecure-content|ignore-certificate-errors(-spki-list)?|js-flags|load-extension|disable-features|host-rules|host-resolver-rules|proxy-server|user-data-dir)(=|$)/.test(a),
  );
}
