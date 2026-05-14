import type { AISecretaryRPC } from "../shared/rpc";

type RequestHandlers = Record<string, (payload: unknown) => unknown>;
type MessageHandlers = Record<string, (payload: unknown) => void>;

type ElectronRpc = {
  request: (name: string, payload: unknown) => Promise<unknown>;
  send: (name: string, payload: unknown) => void;
  onMessage: (name: string, callback: (payload: unknown) => void) => () => void;
};

declare global {
  interface Window {
    electronAPI?: ElectronRpc;
  }
}

export function defineRPC<T>(_config: {
  maxRequestTime?: number;
  handlers: {
    requests?: RequestHandlers;
    messages?: MessageHandlers;
  };
}) {
  const bridge = window.electronAPI;
  if (!bridge) {
    throw new Error("Electron preload bridge not available");
  }

  const request = new Proxy({}, {
    get(_target, prop: string) {
      return (payload: unknown) => bridge.request(prop, payload ?? {});
    },
  }) as T extends { bun: { requests: infer R } } ? R : Record<string, (payload: unknown) => Promise<unknown>>;

  const send = new Proxy({}, {
    get(_target, prop: string) {
      return (payload: unknown) => bridge.send(prop, payload ?? {});
    },
  }) as T extends { bun: { messages: infer M } } ? M : Record<string, (payload: unknown) => void>;

  const messageHandlers = _config.handlers.messages ?? {};
  const requestHandlers = _config.handlers.requests ?? {};
  const unsubscribers = [
    ...Object.entries(messageHandlers).map(([name, handler]) => bridge.onMessage(name, (payload) => {
      console.log(`[renderer-rpc] message ${name}`, payload);
      return handler(payload);
    })),
    ...Object.entries(requestHandlers).map(([name, handler]) => bridge.onMessage(name, (payload) => {
      console.log(`[renderer-rpc] request ${name}`, payload);
      return handler(payload);
    })),
  ];

  window.addEventListener("beforeunload", () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  return { request, send } as unknown as {
    request: AISecretaryRPC["bun"] extends { requests: infer R } ? R : never;
    send: AISecretaryRPC["bun"] extends { messages: infer M } ? M : never;
  };
}

export class ElectronView {
  rpc: ReturnType<typeof defineRPC<AISecretaryRPC>>;

  constructor(options: { rpc: ReturnType<typeof defineRPC<AISecretaryRPC>> }) {
    this.rpc = options.rpc;
  }
}
