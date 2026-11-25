import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type ExecuteRequest, type WindowState } from '../core/ipc.ts';

/**
 * The whole bridge between the browser UI and the main process: four
 * functions. `ipcRenderer` itself is never exposed, so the UI cannot name
 * its own channels.
 */
const api = {
  execute: (request: ExecuteRequest): Promise<unknown> => ipcRenderer.invoke(IPC.execute, request),
  paletteSearch: (query: string): Promise<unknown> => ipcRenderer.invoke(IPC.paletteSearch, query),
  paletteClose: (): void => ipcRenderer.send(IPC.paletteClose),
  onState: (listener: (state: WindowState) => void): void => {
    ipcRenderer.on(IPC.state, (_event, state: WindowState) => listener(state));
    ipcRenderer.send(IPC.ready);
  },
};

contextBridge.exposeInMainWorld('anne', api);

export type AnneApi = typeof api;
