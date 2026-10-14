/** Finite, low-disclosure diagnostics for failed host tests.
 * NEVER persist arbitrary stdout/stderr. High-risk names are omitted.
 * This is a best-effort redaction, not a substitute for secret-free test fixtures. */
import type {TestDiagnosticPolicy} from "./private-test-diagnostics.js";
const SENSITIVE=/(?:secret|token|password|passwd|apikey|api[_-]?key|bearer|credential|private|auth|email|ssn|session|ghp_|sk-)/i;
export function boundedFailureDiagnostics(stdout:string,stderr:string,policy?:TestDiagnosticPolicy):string{
  const combined=(stdout+"\n"+stderr).slice(0,100_000);
  const tests:Array<{number:number;name:string}>=[];
  const codes:string[]=[];
  const seen=new Set<string>();
  for(const line of combined.split(/\r?\n/)){
    const failure=line.match(/^\s*(?:#\s*)?not ok\s+(\d+)\s+-\s+(.{1,180})$/i);
    if(failure&&tests.length<12){
      const number=Number(failure[1]);
      let name=failure[2]!.trim().slice(0,90);
      if(!/^[a-zA-Z0-9][a-zA-Z0-9 _.,:/()#-]{0,89}$/.test(name)||
        SENSITIVE.test(name)||/[a-zA-Z0-9]{18,}/.test(name))
        name="[redacted]";
      if(policy){
        const original=failure[2]!.trim();
        name=Object.hasOwn(policy.labels,original)?policy.labels[original]!:"[withheld: not allowlisted]";
      }
      if(Number.isSafeInteger(number)&&number>0)tests.push({number,name});
    }
    for(const match of line.matchAll(/\bTS\d{4,5}\b/g)){
      if(policy?.compilerCodes!==false&&codes.length<12&&!seen.has(match[0])){codes.push(match[0]);seen.add(match[0]);}
    }
  }
  return JSON.stringify({failedTests:tests,compilerCodes:codes,
    outputTruncated:stdout.length+stderr.length>100_000});
}
