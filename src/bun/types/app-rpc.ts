import type { AISecretaryRPC } from "./rpc";

export type AppRpc = {
  send: AISecretaryRPC["webview"]["messages"];
  request: AISecretaryRPC["webview"]["requests"];
};
