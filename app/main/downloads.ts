import { join } from 'node:path';
import { type DownloadItem, dialog, type Session, shell, type WebContents } from 'electron';
import type { ListItem } from '../core/ipc.ts';
import { isDangerousFile, sanitizeFilename } from '../core/security/downloads.ts';
import { displayUrl } from '../core/security/url-policy.ts';

type DownloadState = 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';

interface DownloadRecord {
  id: number;
  filename: string;
  url: string;
  savePath: string;
  state: DownloadState;
  received: number;
  total: number;
  dangerous: boolean;
  partition: string;
  item: DownloadItem;
}

export interface DownloadHooks {
  /** The window a page belongs to, to parent dialogs. */
  windowFor(wc: WebContents): Electron.BaseWindow | undefined;
  changed(): void;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * Downloads for this run of the browser. The list is kept in memory only;
 * the files themselves stay where the user saved them.
 */
export class Downloads {
  private readonly records = new Map<number, DownloadRecord>();
  private nextId = 1;
  private readonly hooks: DownloadHooks;
  /** Development builds may save without a dialog, for the end-to-end test. */
  private readonly devDir: string | undefined;

  constructor(hooks: DownloadHooks, devDir?: string) {
    this.hooks = hooks;
    this.devDir = devDir;
  }

  get count(): number {
    return this.records.size;
  }

  attach(ses: Session, partition: string): void {
    ses.on('will-download', (event, item, wc) => {
      const filename = sanitizeFilename(item.getFilename());
      const url = item.getURL();
      const dangerous = isDangerousFile(filename);
      // Warn before anything is written. The answer is needed before this handler returns,
      // because Electron shows its save dialog (or starts saving) as soon as it does.
      if (dangerous && !this.confirmDangerous(wc, filename, url)) {
        event.preventDefault();
        return;
      }
      if (this.devDir) item.setSavePath(join(this.devDir, filename));
      else item.setSaveDialogOptions({ defaultPath: filename });

      const record: DownloadRecord = {
        id: this.nextId++, filename, url, savePath: '', state: 'progressing',
        received: 0, total: item.getTotalBytes(), dangerous, partition, item,
      };
      this.records.set(record.id, record);
      item.on('updated', (_e, state) => {
        record.received = item.getReceivedBytes();
        record.total = item.getTotalBytes();
        record.savePath = item.getSavePath();
        record.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
        this.hooks.changed();
      });
      item.once('done', (_e, state) => {
        record.received = item.getReceivedBytes();
        record.savePath = item.getSavePath();
        record.state = state;
        // Cancelled from the save dialog: nothing was saved, so nothing to list.
        if (state === 'cancelled' && record.savePath === '') this.records.delete(record.id);
        this.hooks.changed();
      });
      this.hooks.changed();
    });
  }

  private confirmDangerous(wc: WebContents | undefined, filename: string, url: string): boolean {
    const parent = wc ? this.hooks.windowFor(wc) : undefined;
    let host = '';
    try { host = new URL(url).host; } catch { /* data: or blob: URL */ }
    const options: Electron.MessageBoxSyncOptions = {
      type: 'warning',
      buttons: ['Cancel', 'Download Anyway'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      title: 'Download warning',
      message: `"${filename}" can run programs on your computer.`,
      detail: `${host ? `It comes from ${host}${url.startsWith('http:') ? ', over an unencrypted connection' : ''}. ` : ''}Download it only if you trust the site and expected this file.`,
    };
    const answer = parent ? dialog.showMessageBoxSync(parent as Electron.BaseWindow, options) : dialog.showMessageBoxSync(options);
    return answer === 1;
  }

  list(query: string): ListItem[] {
    const q = query.toLowerCase();
    return [...this.records.values()]
      .reverse()
      .filter((r) => !q || r.filename.toLowerCase().includes(q) || r.url.toLowerCase().includes(q))
      .slice(0, 500)
      .map((r): ListItem => {
        const size = r.total > 0 ? formatBytes(r.total) : formatBytes(r.received);
        const detail = {
          progressing: r.total > 0 ? `${Math.floor((r.received / r.total) * 100)}% of ${size}` : `${formatBytes(r.received)} so far`,
          paused: 'Paused',
          completed: `Completed, ${size}`,
          cancelled: 'Cancelled',
          interrupted: 'Failed',
        }[r.state] + (r.dangerous ? ' · can run programs' : '');
        return {
          id: r.id,
          title: r.filename,
          url: displayUrl(r.url).slice(0, 500),
          detail,
          remove: 'tools.download-dismiss',
          ...(r.state === 'completed' && {
            open: 'tools.download-open',
            secondary: { command: 'tools.download-show', label: 'Show in folder' },
          }),
        };
      });
  }

  private completed(id: number): DownloadRecord {
    const r = this.records.get(id);
    if (!r || r.state !== 'completed' || !r.savePath) throw new Error('that download is not finished');
    return r;
  }

  async open(id: number, parent: Electron.BaseWindow): Promise<void> {
    const r = this.completed(id);
    if (r.dangerous) {
      const { response } = await dialog.showMessageBox(parent, {
        type: 'warning', buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, noLink: true,
        message: `"${r.filename}" can run programs on your computer.`,
        detail: 'Open it only if you trust where it came from.',
      });
      if (response !== 1) return;
    }
    const error = await shell.openPath(r.savePath);
    if (error) throw new Error(error);
  }

  show(id: number): void {
    shell.showItemInFolder(this.completed(id).savePath);
  }

  /** Cancel a download in progress, or take a finished one off the list. The file is never deleted. */
  dismiss(id: number): void {
    const r = this.records.get(id);
    if (!r) return;
    if (r.state === 'progressing' || r.state === 'paused') r.item.cancel();
    else this.records.delete(id);
    this.hooks.changed();
  }

  clearFinished(): void {
    for (const [id, r] of this.records) if (r.state !== 'progressing' && r.state !== 'paused') this.records.delete(id);
    this.hooks.changed();
  }

  /** A private window closed: cancel its downloads in progress and forget all of its entries. */
  forgetPartition(partition: string): void {
    for (const [id, r] of this.records) {
      if (r.partition !== partition) continue;
      if (r.state === 'progressing' || r.state === 'paused') r.item.cancel();
      this.records.delete(id);
    }
    this.hooks.changed();
  }
}
