/** UI-only canvas preferences. Never persist user prompts, events or Session credentials. */
import type { CanvasPosition } from "./canvas-layout.js";

export type NodeDensity = "compact" | "expanded";
export interface CanvasPreferences {
  dimmed: boolean;
  positions: Map<string, CanvasPosition>;
  density: Map<string, NodeDensity>;
}
const VERSION = 1;
const MAX_ITEMS = 200;
const MAX_RAW_LENGTH = 64000;
function blank(): CanvasPreferences {
  return {dimmed:false,positions:new Map(),density:new Map()};
}
export function canvasStorageKey(scope: string): string {
  // Scope already includes machine, project and workspace, unlike shared per-role IDs.
  return "pi-micromanager:orchestra-canvas:v1:" + scope;
}
export function parseCanvasPreferences(raw: string | null | undefined): CanvasPreferences {
  if(!raw || raw.length>MAX_RAW_LENGTH)return blank();
  try {
    const value:unknown=JSON.parse(raw);
    if(!value||typeof value!=="object"||Array.isArray(value))return blank();
    const parsed=value as Record<string,unknown>;
    if(parsed.version!==VERSION)return blank();
    const result=blank();
    result.dimmed=parsed.dimmed===true;
    if(Array.isArray(parsed.positions)){
      for(const entry of parsed.positions.slice(0,MAX_ITEMS)){
        if(!Array.isArray(entry)||entry.length!==3)continue;
        const [key,x,y]=entry as unknown[];
        if(typeof key!=="string"||key.length>512||key.length===0||
          typeof x!=="number"||!Number.isFinite(x)||
          typeof y!=="number"||!Number.isFinite(y))continue;
        result.positions.set(key,{x,y});
      }
    }
    if(Array.isArray(parsed.density)){
      for(const entry of parsed.density.slice(0,MAX_ITEMS)){
        if(!Array.isArray(entry)||entry.length!==2)continue;
        const [key,density]=entry as unknown[];
        if(typeof key!=="string"||!key||key.length>512||
          (density!=="compact"&&density!=="expanded"))continue;
        result.density.set(key,density);
      }
    }
    return result;
  } catch {return blank();}
}
export function serializeCanvasPreferences(preferences: CanvasPreferences): string {
  const positions=[...preferences.positions].filter(([key,p])=>
    !!key&&key.length<=512&&Number.isFinite(p.x)&&Number.isFinite(p.y))
    .slice(-MAX_ITEMS).map(([key,p])=>[key,Math.round(p.x),Math.round(p.y)]);
  const density=[...preferences.density].filter(([key,value])=>
    !!key&&key.length<=512&&(value==="compact"||value==="expanded"))
    .slice(-MAX_ITEMS);
  return JSON.stringify({version:VERSION,dimmed:preferences.dimmed===true,positions,density});
}
