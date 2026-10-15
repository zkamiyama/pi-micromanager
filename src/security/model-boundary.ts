/** Admission at the SDK call boundary, not a notification hook whose errors
 * the SDK may report and suppress. Cancellation must remain possible at zero budget.
 * Bind delegated methods to the original SDK object to preserve private fields. */
import type {Models} from "@earendil-works/pi-ai/models";
const REQUESTS=new Set<PropertyKey>([
  "stream","streamSimple","complete","completeSimple",
  "streamDeferred","fetchDeferred","generateImages","classify",
]);
export function withModelBudget(models:Models,admit:()=>void,maxOutputTokens?:number):Models {
  if(maxOutputTokens!==undefined&&(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1||maxOutputTokens>8192))
    throw new Error("Invalid per-request output bound");
  return new Proxy(models,{
    get(target,property){
      const value=Reflect.get(target,property,target) as unknown;
      if(typeof value!=="function")return value;
      return (...args:unknown[])=>{
        if(REQUESTS.has(property)){
          admit();
          if(maxOutputTokens!==undefined){
            // Automatic diagnosis uses text-only SDK requests. Unsupported
            // request types cannot escape its finite output allowance.
            if(!["stream","streamSimple","complete","completeSimple"].includes(String(property)))
              throw new Error("Diagnostic model request kind is not bounded");
            const original=args[2];
            const options=original&&typeof original==="object"?original as Record<string,unknown>:{};
            const requested=options.maxTokens;
            args[2]={...options,maxTokens:typeof requested==="number"&&Number.isSafeInteger(requested)&&requested>0?
              Math.min(requested,maxOutputTokens):maxOutputTokens};
          }
        }
        return Reflect.apply(value,target,args);
      };
    },
  });
}
