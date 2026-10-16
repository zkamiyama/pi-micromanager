import {uiText} from "./ui-locale.js";
/** Local-only evidence UI. No external publisher, native-session GC, or model call. */
import type {WorkspacePanelContext} from "@jmfederico/pi-web/plugin-api";
import type {WorkflowJournal} from "../automation/journal.js";
import type {LocalArtifact} from "../automation/local-artifacts.js";

type Html=(strings:TemplateStringsArray,...values:unknown[])=>unknown;
interface ViewState {
  runId:string;file?:File;label:string;path:string;workspaceId:string;
  busy:boolean;message:string;uploadId?:string;maintenanceId?:string;
  preview?:{artifact:LocalArtifact;text?:string;dataUrl?:string};
}
export function createLocalJournalPanel(html:Html,signal:AbortSignal){
  const states=new Map<string,ViewState>();
  signal.addEventListener("abort",()=>states.clear(),{once:true});
  return (context:WorkspacePanelContext,journal:WorkflowJournal,isCurrent:()=>boolean,
    replace:(next:WorkflowJournal)=>void)=>{
    if(!journal.local)return null;
    const key=JSON.stringify([context.machine.id,context.workspace.projectId,context.workspace.id,journal.workflowId]);
    let found=states.get(key);
    if(!found){found={runId:"",label:"Local operator image",path:"docs/adr/0001-decision.md",workspaceId:context.workspace.id,busy:false,message:"Images stay local; ADRs remain in Git."};states.set(key,found);}
    const state=found,local=journal.local;
    const active=()=>!signal.aborted&&isCurrent();
    const send=async(operation:string,input:unknown):Promise<any>=>{
      if(!active()||!context.peer?.request)throw new Error("Selected Journal scope changed");
      return context.peer.request(operation,input as never);
    };
    const refresh=async()=>{
      const next=await send("auto.journal",{workflowId:journal.workflowId}) as WorkflowJournal;
      if(active()&&next.workflowId===journal.workflowId)replace(next);
    };
    const action=async(fn:()=>Promise<void>)=>{
      if(state.busy||!active())return;
      state.busy=true;context.host.requestRender();
      try{await fn();}
      catch(error){if(active())state.message="Operation not confirmed: "+String(error).slice(0,350)+". Inspect/recheck the same request; do not blindly duplicate it.";}
      finally{state.busy=false;if(active())context.host.requestRender();}
    };
    const currentQc=journal.runs.filter(r=>r.seat==="qc"&&r.phase==="sealed"&&
      journal.tasks.some(t=>t.lastQc?.runId===r.runId));
    const selected=currentQc.find(r=>r.runId===state.runId);
    const source=journal.tasks.find(t=>t.lastQc?.runId===selected?.runId)?.lastQc?.headSha;
    const importImage=()=>action(async()=>{
      const file=state.file,runId=state.runId,label=state.label;
      if(!file||file.size<16||file.size>180*1024||!source||!selected)throw new Error("Select a current sealed QC and an image no larger than 180 KiB");
      const requestId=state.uploadId??=crypto.randomUUID();
      const bytes=new Uint8Array(await file.arrayBuffer());
      if(bytes.length!==file.size||!active()||state.file!==file||state.runId!==runId||state.label!==label)
        throw new Error("Image or selected source changed before upload");
      let binary="";for(let pos=0;pos<bytes.length;pos+=8192)binary+=String.fromCharCode(...bytes.subarray(pos,pos+8192));
      const artifact=await send("auto.journal.local.import",{workflowId:journal.workflowId,runId,sourceSha:source,requestId,label,base64:btoa(binary)}) as LocalArtifact;
      if(active()){
        state.message="Stored operator-provided image locally: "+artifact.sha256+". This upload is not an attestation that QC captured the image.";
        await refresh();
      }
    });
    const read=(artifact:LocalArtifact)=>action(async()=>{
      const result=await send("auto.journal.local.read",{artifactId:artifact.id});
      if(result.artifact?.id!==artifact.id||result.artifact?.workflowId!==journal.workflowId)throw new Error("Artifact response identity changed");
      if(active()){state.preview=result;state.message="Verified local bytes; not sent to a model or remote repository.";}
    });
    const pin=(artifact:LocalArtifact)=>action(async()=>{
      await send("auto.journal.local.pin",{artifactId:artifact.id,pinned:!artifact.pinned});
      if(active()){state.message=artifact.pinned?"Pin released; other holds still apply.":"Pinned. This Workflow's artifacts and owned resources are retained.";await refresh();}
    });
    const link=()=>action(async()=>{
      await send("auto.journal.adr.link",{workflowId:journal.workflowId,workspaceId:state.workspaceId,path:state.path});
      if(active()){state.message="Linked the exact Git ADR commit. No commit, push, or PR was created.";await refresh();}
    });
    const maintain=()=>action(async()=>{
      const requestId=state.maintenanceId??=crypto.randomUUID();
      const receipt=await send("auto.maintenance.run",{workflowId:journal.workflowId,requestId});
      if(!active())return;
      state.message="Maintenance "+receipt.id+": "+receipt.phase+". Refresh the Journal to inspect its persisted outcome.";
      await refresh();
    });
    const safeLink=(link:NonNullable<WorkflowJournal["local"]>["adrLinks"][number])=>
      link.url&&/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/blob\/(?:[a-f0-9]{40}|[a-f0-9]{64})\/docs\/adr\/[A-Za-z0-9_.-]+\.md$/.test(link.url)?link.url:null;
    return html`<section class="mm-local-journal" aria-label="Local Journal resources">
      <h3>Local storage usage</h3>
      <p>${local.usage.storedBytes} / ${local.usage.maxBytes} bytes · ${local.usage.maxAgeDays} day retention · ${local.usage.unresolved} unconfirmed artifact operations.</p>
      <p>Pins retain this Workflow's resources. Human native Sessions, Git branches and ADR documents are not deleted.</p>
      <div class="mm-actions">
        <button ?disabled=${state.busy} @click=${()=>void action(refresh)}>Refresh local Journal</button>
        <button ?disabled=${state.busy||local.status.phase==="running"||local.status.phase==="uncertain"}
          @click=${()=>void maintain()}>Run local maintenance</button>
      </div>
      ${["completed","blocked"].includes(local.status.phase)&&state.maintenanceId?html`
        <button ?disabled=${state.busy} @click=${()=>{delete state.maintenanceId;state.message="New maintenance pass selected. Existing resource receipts still prevent duplicate deletion.";context.host.requestRender();}}>Select new maintenance pass</button>`:null}
      <p role="status">Maintenance: ${uiText(local.status.phase)} · ${local.status.message}</p>
      <h3>Local operator images</h3>
      <p>PNG or JPEG, at most 180 KiB and 4096 pixels per dimension. Select the current sealed QC source. Upload is a local annotation, not QC capture proof. Inspect for secrets first.</p>
      <label>Local image QC Run<select aria-label="Local image QC Run" .value=${state.runId} ?disabled=${state.busy}
        @change=${(e:Event)=>{state.runId=(e.target as HTMLSelectElement).value;delete state.uploadId;context.host.requestRender();}}>
        <option value="">Choose current sealed QC</option>
        ${currentQc.map(r=>html`<option value=${r.runId}>${r.runId}</option>`)}
      </select></label>
      <label>Local image file<input aria-label="Local image file" type="file" accept="image/png,image/jpeg" ?disabled=${state.busy}
        @change=${(e:Event)=>{const file=(e.target as HTMLInputElement).files?.[0];if(file)state.file=file;else delete state.file;delete state.uploadId;context.host.requestRender();}}/></label>
      <label>Local image label<input aria-label="Local image label" maxlength="180" .value=${state.label} ?disabled=${state.busy}
        @input=${(e:Event)=>{state.label=(e.target as HTMLInputElement).value;delete state.uploadId;}}/></label>
      <button ?disabled=${state.busy||!state.file||!selected} @click=${()=>void importImage()}>Import local image</button>
      <h3>Local images and compressed activity (up to 100)</h3>
      ${local.artifacts.map(a=>html`<article class="mm-local-artifact">
        <strong>${a.label}</strong><p>${uiText(a.kind)} · ${a.provenance} · ${uiText(a.state)} · ${a.storedBytes} bytes</p>
        <p>Run ${a.runId} · source <code>${a.sourceSha}</code> · sha256:<code>${a.sha256}</code></p>
        <button ?disabled=${state.busy||a.state!=="ready"} @click=${()=>void read(a)}>${uiText(a.kind==="image"?"View local image":"Read compressed activity")}</button>
        <button ?disabled=${state.busy||a.state!=="ready"} @click=${()=>void pin(a)}>${uiText(a.pinned?"Unpin local artifact":"Pin local artifact")}</button>
        ${state.preview?.artifact.id===a.id&&a.state==="ready"?(state.preview.dataUrl&&/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(state.preview.dataUrl)?html`
          <img class="mm-screenshot-preview" loading="lazy" src=${state.preview.dataUrl} alt=${"Local operator image: "+a.label}/>`:
          html`<pre class="mm-local-log">${state.preview.text??""}</pre>`):null}
      </article>`)}
      <h3>Git ADR references</h3>
      <p>Git docs/adr is authoritative. Linking does not publish Journal data or images.</p>
      <label>ADR Workspace ID<input aria-label="ADR Workspace ID" maxlength="128" .value=${state.workspaceId} ?disabled=${state.busy}
        @input=${(e:Event)=>{state.workspaceId=(e.target as HTMLInputElement).value;}}/></label>
      <label>ADR tracked path<input aria-label="ADR tracked path" maxlength="180" .value=${state.path} ?disabled=${state.busy}
        @input=${(e:Event)=>{state.path=(e.target as HTMLInputElement).value;}}/></label>
      <button ?disabled=${state.busy} @click=${()=>void link()}>Link Git ADR</button>
      ${local.adrLinks.map(a=>html`<p>${safeLink(a)?html`<a href=${safeLink(a)!} target="_blank" rel="noopener noreferrer">${a.title}</a>`:html`<strong>${a.title}</strong>`}
        · <code>${a.path}</code> at <code>${a.commit}</code></p>`)}
      <h3>Owned Worktree retirement receipts</h3>
      ${local.retirements.map(r=>html`<p>${r.taskId} · ${r.state} · <code>${r.headSha}</code> · retained Git ref <code>${r.preservedRef}</code></p>`)}
      <p role="status">${uiText(state.message)}</p>
    </section>`;
  };
}
