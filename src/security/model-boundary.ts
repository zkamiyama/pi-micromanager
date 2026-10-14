/** Admission at the SDK call boundary, not a notification hook whose errors
 * the SDK may report and suppress. Cancellation must remain possible at zero budget.
 * Bind delegated methods to the original SDK object to preserve private fields. */
import type {Models} from "@earendil-works/pi-ai/models";
const REQUESTS=new Set<PropertyKey>([
  "stream","streamSimple","complete","completeSimple",
  "streamDeferred","fetchDeferred","generateImages","classify",
]);
export function withModelBudget(models:Models,admit:()=>void):Models {
  return new Proxy(models,{
    get(target,property){
      const value=Reflect.get(target,property,target) as unknown;
      if(typeof value!=="function")return value;
      return (...args:unknown[])=>{
        if(REQUESTS.has(property))admit();
        return Reflect.apply(value,target,args);
      };
    },
  });
}
