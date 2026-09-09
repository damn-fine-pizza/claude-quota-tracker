import { readFileSync } from "node:fs";
import { CONFIG_PATH, saveConfigPatch } from "./config.js";
export interface ManualOverride { enabled: boolean; reserveProfile: string | null; preempt: boolean; }
export const DEFAULT_OVERRIDE: ManualOverride = { enabled:false, reserveProfile:null, preempt:false };
export function loadOverride(): ManualOverride { try { return {...DEFAULT_OVERRIDE,...(JSON.parse(readFileSync(CONFIG_PATH,"utf8")).override??{})}; } catch { return DEFAULT_OVERRIDE; } }
export function setOverride(next: Partial<ManualOverride>): ManualOverride { const value={...loadOverride(),...next}; if(value.reserveProfile&&/yolo/i.test(value.reserveProfile)) throw new Error("yolo cannot be reserved"); saveConfigPatch({override:value} as never); return value; }
