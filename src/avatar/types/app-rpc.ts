import { defineRPC } from "../electron-rpc";
import type { AISecretaryRPC } from "../../shared/rpc";

export type ElectronRpcRPC = ReturnType<typeof defineRPC<AISecretaryRPC>>;

export interface ElectronRpcInstance {
  rpc: ElectronRpcRPC;
}

export type RPCSendMethods = ElectronRpcRPC["send"];
export type RPCRequestMethods = ElectronRpcRPC["request"];
