import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  request: (name: string, payload: unknown) => ipcRenderer.invoke("rpc-request", { name, payload }),
  send: (name: string, payload: unknown) => ipcRenderer.send("rpc-message", { name, payload }),
  onMessage: (name: string, callback: (payload: unknown) => void) => {
    const sendChannel = `rpc-send:${name}`;
    const sendListener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on(sendChannel, sendListener);

    const requestChannel = `rpc-request-renderer:${name}`;
    const requestListener = async (_event: Electron.IpcRendererEvent, packet: { id: number; payload: unknown }) => {
      try {
        const result = await callback(packet.payload);
        ipcRenderer.send("rpc-renderer-response", { id: packet.id, result });
      } catch (error) {
        ipcRenderer.send("rpc-renderer-response", { id: packet.id, error: error instanceof Error ? error.message : String(error) });
      }
    };
    ipcRenderer.on(requestChannel, requestListener);

    return () => {
      ipcRenderer.removeListener(sendChannel, sendListener);
      ipcRenderer.removeListener(requestChannel, requestListener);
    };
  },
});
