import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ExecuteRequest, type ListKind, type WindowState } from '../core/ipc.ts';

/**
 * The whole bridge between the browser UI and the main process: five
 * functions. `ipcRenderer` itself is never exposed, so the UI cannot name
 * its own channels.
 */
const api = {
  execute: (request: ExecuteRequest): Promise<unknown> => ipcRenderer.invoke(IPC.execute, request),
  paletteSearch: (query: string): Promise<unknown> => ipcRenderer.invoke(IPC.paletteSearch, query),
  list: (request: { kind: ListKind; query: string }): Promise<unknown> => ipcRenderer.invoke(IPC.list, request),
  closeOverlay: (): void => ipcRenderer.send(IPC.closeOverlay),
  onState: (listener: (state: WindowState) => void): void => {
    ipcRenderer.on(IPC.state, (_event, state: WindowState) => listener(state));
    ipcRenderer.send(IPC.ready);
  },
};

contextBridge.exposeInMainWorld('anne', api);

export type AnneApi = typeof api;
