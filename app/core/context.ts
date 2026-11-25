/**
 * Context keys that `when` and `checked` expressions may read. The catalog
 * build rejects any other key, so a typo cannot silently disable a command.
 */
export const CONTEXT_KEYS = {
  'tab.count': 'number',
  'tab.canGoBack': 'boolean',
  'tab.canGoForward': 'boolean',
  'tab.isLoading': 'boolean',
  'tab.hasClosed': 'boolean',
  'page.scheme': 'string',
  'page.zoom': 'number',
  'window.isFullScreen': 'boolean',
  'input.modal': 'boolean',
  'ui.paletteOpen': 'boolean',
  'ui.layout': 'string',
  'ui.keymap': 'string',
} as const;

export type ContextKey = keyof typeof CONTEXT_KEYS;
