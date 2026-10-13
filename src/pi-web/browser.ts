/** PI WEB workspace panel: distinct simulation preview and real, opt-in Pi Autopilot. */
import { createLiveRunPanel, selectOrchestraTask } from "./fleet.js";
import type { PiWebPlugin, WorkspacePanelContext } from "@jmfederico/pi-web/plugin-api";
import type { WorkflowAction, WorkflowDefinition, WorkflowInstance, TaskState, Role } from "../core/workflow.js";
import type { WorkflowJournal } from "../automation/journal.js";
import type { RetentionPreview } from "../automation/retention.js";
import type { ApprovalRequest } from "../automation/permissions.js";
import type { PublishedOperation } from "../automation/publication.js";
import type { ConvergenceReceipt } from "../automation/convergence.js";
import type { AdrDraft, AdrFields } from "../automation/adr-promotion.js";
import type { QuickGoal, QuickProfile } from "../automation/quick-launch.js";

const DEMO: WorkflowDefinition = {
  id: "demo-auth", title: "Auth migration — workflow preview", maxQcRounds: 5,
  maxParallelByRole: { planner: 1, implementer: 2, reviewer: 2, architect: 2 },
  tasks: [
    { id: "contract", title: "Define contract", kind: "implementation", role: "implementer", dependsOn: [] },
    { id: "api", title: "Implement API", kind: "implementation", role: "implementer", dependsOn: [{ taskId: "contract", gate: "qc_passed" }] },
    { id: "ui", title: "Implement UI", kind: "implementation", role: "implementer", dependsOn: [{ taskId: "contract", gate: "qc_passed" }] },
    { id: "integration", title: "Integration tests", kind: "implementation", role: "implementer", dependsOn: [{ taskId: "api", gate: "qc_passed" }, { taskId: "ui", gate: "qc_passed" }] },
  ],
};
type View = "cockpit" | "dag" | "kanban" | "journal";
type Detail = "compact" | "expanded";
type InterventionMode = "workflow" | "implementer" | "qc";
interface State {
  quickGoalText:string;quickProfile:QuickProfile|null;quickGoals:QuickGoal[];
  quickSetupDraft:string;quickSetupLoaded:boolean;quickPolling:boolean;
  quickError:string;quickRequestId?:string;
  quickSimpleProvider:string;quickSimpleModel:string;
  quickTestFile:string;quickTestArgs:string;
  quickRemote:string;quickBase:string;quickMerge:"allow"|"ask"|"deny";
  quickRuntime:"durable"|"pi-web";
  quickAdvanced:boolean;
  workflows: WorkflowInstance[];
  journal?:WorkflowJournal;
  adrTargetWorkspaceId:string;
  adrFields:AdrFields;
  adrStatus:string;
  adrDraft?:AdrDraft;
  screenshotRunId:string;
  screenshotPath:string;
  screenshotStatus:string;
  screenshotPreview?:{id:string;dataUrl:string|null;sha256:string;mime:string};
  retentionDays:number;
  retentionPreview?:RetentionPreview;
  retentionStatus:string;
  selected?: WorkflowInstance;
  status: string;
  busy: boolean;
  loaded: boolean;
  view: View;
  detailByRole: Record<Role, Detail>;
  selectedTaskId?: string;
  interventionMode: InterventionMode;
  interventionDraft: string;
  autopilotDraft: string;
  finalWorktreeWorkspaceId:string;
  autopilotStatus: string;
  permissionStatus:string;
  approvalRequests:ApprovalRequest[];
  publishedOperations:PublishedOperation[];
  convergenceReceipts:ConvergenceReceipt[];
  autopilotEnabled: boolean;
  autopilotConfigured: boolean;
  autopilotConfigFor?:string;
  workflowDraft:string;
  worktreeTaskId:string;
  worktreeWorkspaceId:string;
  worktreeStatus:string;
  worktreePlan?:{
    id:string;workflowId:string;taskId:string;path:string;branch:string;
    baseSha:string;stage:"prepared"|"reserved"|"created";expiresAt:number;
  };
  integrationTargetWorkspaceId:string;
  integrationStatus:string;
  integrationPreview?:{
    id:string;workflowId:string;taskId:string;targetWorkspaceId:string;
    sourceSha:string;targetHead:string;qcRunId:string;expiresAt:number;
  };
  goalText:string;goalProvider:string;goalModel:string;goalEffort:string;
  goalStatus:string;goalProposalText:string;goalProposalReady:boolean;
  goalRef?:{draftWorkflowId:string;runId:string};
}
const roleNames: Role[] = ["planner", "implementer", "reviewer", "architect"];
const states = new Map<string, State>();
const keyFor = (context: WorkspacePanelContext) => JSON.stringify([context.machine.id, context.workspace.projectId, context.workspace.id]);
function stateFor(context: WorkspacePanelContext): State {
  const key = keyFor(context);
  let state = states.get(key);
  if (!state) {
    let goalRef:State["goalRef"];
    try{
      const raw=typeof localStorage==="undefined"?null:
        localStorage.getItem("pi-micromanager:goal-ref:"+key);
      const value:unknown=raw?JSON.parse(raw):null;
      if(value&&typeof value==="object"&&!Array.isArray(value)&&
        "draftWorkflowId" in value&&typeof value.draftWorkflowId==="string"&&
        "runId" in value&&typeof value.runId==="string")
        goalRef={draftWorkflowId:value.draftWorkflowId,runId:value.runId};
    }catch{/* Browser storage may be blocked. */}
    state = { workflows: [],
      quickGoalText:"",quickProfile:null,quickGoals:[],quickSetupLoaded:false,
      quickPolling:false,quickError:"",
      quickSimpleProvider:"",quickSimpleModel:"",
      quickTestFile:"node",quickTestArgs:"--test",
      quickRemote:"origin",quickBase:"main",quickMerge:"ask",
      quickRuntime:"durable",quickAdvanced:false,
      quickSetupDraft:JSON.stringify({
        config:{runtime:"durable",managedWorktrees:true,workspaces:{},
          finalization:{workspaceId:"auto",autoMerge:true},
          publication:{remote:"origin",baseBranch:"main",draft:true},
          models:Object.fromEntries(["planner","implementer","qc","architect"]
            .map(r=>[r,{provider:"REPLACE_WITH_PI_PROVIDER",model:"REPLACE_WITH_PI_MODEL"}])),
          test:{file:"node",args:["--test"],timeoutMs:60000},maxAttempts:3},
        permissions:{default:"allow",
          actions:{"github.pr.merge":"ask","deploy.production":"deny"}},
      },null,2),
      adrTargetWorkspaceId:"",adrStatus:"",
      adrFields:{filename:"0010-record-decision.md",title:"Architectural decision",
        context:"",options:"",decision:"",consequences:""},
      screenshotRunId:"",screenshotPath:"screenshots/qc.png",
      screenshotStatus:"",retentionDays:30,retentionStatus:"", status: "Load workflows to begin.", busy: false, loaded: false, view: "cockpit",
      detailByRole: { planner: "expanded", implementer: "compact", reviewer: "expanded", architect: "expanded" },
      finalWorktreeWorkspaceId:"",
      autopilotDraft:JSON.stringify({
        runtime:"durable",workspaces:{},
        models:{
          implementer:{provider:"",model:""},qc:{provider:"",model:""},
          planner:{provider:"",model:""},architect:{provider:"",model:""},
        },test:{file:"npm",args:["test"],timeoutMs:60000},maxAttempts:5,
        publication:{remote:"origin",baseBranch:"main",draft:true},
      },null,2),
      autopilotStatus:"Not configured",autopilotEnabled:false,autopilotConfigured:false,
      permissionStatus:"No permission decisions loaded",
      approvalRequests:[],publishedOperations:[],convergenceReceipts:[],
      goalText:"",goalProvider:"",goalModel:"",goalEffort:"",
      goalStatus:goalRef?"A prior goal proposal can be checked":"No proposal in progress",
      goalProposalText:"",goalProposalReady:false,
      ...(goalRef?{goalRef}:{}),
      worktreeTaskId:"",worktreeWorkspaceId:"",worktreeStatus:"",
      integrationTargetWorkspaceId:"",integrationStatus:"",
      workflowDraft:JSON.stringify({
        id:"custom-feature",title:"Custom development workflow",maxQcRounds:5,
        maxParallelByRole:{planner:1,implementer:2,reviewer:2,architect:2},
        permissions:{default:"allow",actions:{"github.pr.merge":"ask","deploy.production":"ask"}},
        tasks:[{id:"feature",title:"REPLACE: specific development Task",
          description:"REPLACE: state the exact repository change required",
          acceptanceCriteria:["REPLACE: define an independently testable acceptance condition"],
          kind:"implementation",role:"implementer",dependsOn:[]}],
      },null,2),
      interventionMode: "workflow",
      interventionDraft: "After the next QC, ask Astra and Claude Opus to independently investigate the root cause and alternatives; let Sol synthesize before Luna resumes." };
    states.set(key, state);
  }
  return state;
}
const plugin: PiWebPlugin = {
  apiVersion: 4,
  name: "pi-micromanager",
  activate({ html, lifetimeSignal, runtimePluginId }) {
    let disposed = false;
    let quickContext:WorkspacePanelContext|undefined;
    const quickTimer=setInterval(()=>{
      const context=quickContext;
      if(disposed||!context)return;
      const state=stateFor(context);
      if(!state.quickSetupLoaded||state.quickGoals.some(g=>
        ["reserved","planning","starting","running"].includes(g.phase)))
        void loadQuick(context);
    },2500);
    lifetimeSignal.addEventListener("abort",()=>clearInterval(quickTimer),{once:true});
    async function send(context: WorkspacePanelContext, operation: string, input: unknown): Promise<unknown> {
      if (!context.peer?.request) throw new Error("Enable the pi-micromanager server plugin in PI WEB settings");
      return context.peer.request(operation, input as never);
    }
    async function refresh(context: WorkspacePanelContext, workflowId?: string) {
      const state = stateFor(context);
      if (state.busy) return;
      state.busy = true;
      context.host.requestRender();
      try {
        const result = await send(context, "list", null);
        if (!Array.isArray(result)) throw new Error("Invalid workflow list");
        state.workflows = result as WorkflowInstance[];
        const id = workflowId ?? state.selected?.definition.id ?? state.workflows[0]?.definition.id;
        if (id) {
          if (state.selected?.definition.id !== id){
            delete state.journal;delete state.retentionPreview;
             state.approvalRequests=[];state.publishedOperations=[];state.convergenceReceipts=[];
             state.permissionStatus="Select Load permissions to review current requests";
            delete state.screenshotPreview;
            delete state.adrDraft;state.adrStatus="";
            state.screenshotRunId="";state.screenshotStatus="";
            delete state.selectedTaskId;delete state.worktreePlan;
            state.worktreeTaskId="";state.worktreeStatus="";
          }
          state.selected = await send(context, "get", id) as WorkflowInstance;
          try{
            const auto=await send(context,"auto.status",{workflowId:id}) as
              {enabled:boolean;status:string;config:unknown}|null;
            state.autopilotEnabled=auto?.enabled??false;
            state.autopilotConfigured=!!auto;
            state.autopilotStatus=auto?.status??"Not configured";
            if(auto&&state.autopilotConfigFor!==id){
              state.autopilotDraft=JSON.stringify(auto.config,null,2);
              state.autopilotConfigFor=id;
            }
          }catch(error){state.autopilotStatus="Autopilot unavailable: "+String(error);}
        }
        if (state.selectedTaskId && !state.selected?.tasks[state.selectedTaskId]) delete state.selectedTaskId;
        state.loaded = true;
        state.status = `${state.workflows.length} saved workflow(s).`;
      } catch (error) { state.status = String(error); }
      finally {
        state.busy = false;
        if (!disposed){context.host.requestRender();void loadQuick(context);}
      }
    }
    function hydrateSimpleSetup(state:State,profile:QuickProfile):void{
      const profiles=Object.values(profile.config.models);
      const first=profiles[0];
      const common=first&&profiles.every(x=>
        x.provider===first.provider&&x.model===first.model&&x.effort===first.effort);
      if(common&&first){
        state.quickSimpleProvider=first.provider;
        state.quickSimpleModel=first.model;
      }else state.quickAdvanced=true;
      state.quickTestFile=profile.config.test.file;
      state.quickTestArgs=profile.config.test.args.join("\n");
      state.quickRuntime=profile.config.runtime;
      state.quickRemote=profile.config.publication?.remote??"origin";
      state.quickBase=profile.config.publication?.baseBranch??"main";
      state.quickMerge=profile.permissions.actions?.["github.pr.merge"]??
        profile.permissions.default??"ask";
    }
    function simpleSetup(state:State):unknown{
      if(state.quickAdvanced)return JSON.parse(state.quickSetupDraft) as unknown;
      const provider=state.quickSimpleProvider.trim();
      const model=state.quickSimpleModel.trim();
      if(!provider||!model||provider.includes("REPLACE_WITH")||
        model.includes("REPLACE_WITH"))
        throw new Error("Enter a real Pi provider and model from the session daemon");
      const file=state.quickTestFile.trim();
      const args=state.quickTestArgs.split(/\r?\n/u).map(x=>x.trim()).filter(Boolean);
      const remote=state.quickRemote.trim(),baseBranch=state.quickBase.trim();
      const raw=JSON.parse(state.quickSetupDraft) as {
        config:Record<string,unknown>;
        permissions:{default?:string;actions?:Record<string,string>};
      };
      const models=Object.fromEntries(["planner","implementer","qc","architect"]
        .map(role=>[role,{provider,model}]));
      return {...raw,config:{...raw.config,runtime:state.quickRuntime,
        managedWorktrees:true,workspaces:{},
        models,test:{file,args,timeoutMs:60000},
        publication:{remote,baseBranch,draft:true},
        finalization:{workspaceId:"auto",autoMerge:true}},
        permissions:{...raw.permissions,
          actions:{...raw.permissions.actions,
            "github.pr.merge":state.quickMerge,"deploy.production":"deny"}}};
    }
    async function loadQuick(context:WorkspacePanelContext):Promise<void>{
      const state=stateFor(context);
      if(disposed||state.quickPolling)return;
      state.quickPolling=true;
      try{
        const result=await send(context,"auto.quick.status",null) as {
          profile:QuickProfile|null;goals:QuickGoal[];
        };
        if(!state.quickSetupLoaded){
          if(result.profile){
            state.quickSetupDraft=JSON.stringify(result.profile,null,2);
            hydrateSimpleSetup(state,result.profile);
          }
          state.quickSetupLoaded=true;
        }
        const old=JSON.stringify({profile:state.quickProfile,goals:state.quickGoals});
        state.quickProfile=result.profile;state.quickGoals=result.goals;
        if(old!==JSON.stringify(result))context.host.requestRender();
      }catch(error){
        if(!state.quickProfile&&!state.quickGoals.length){
          state.quickError="Cannot load one-command setup: "+String(error).slice(0,240);
          context.host.requestRender();
        }
      }finally{state.quickPolling=false;}
    }
    async function configureQuick(context:WorkspacePanelContext){
      const state=stateFor(context);if(state.busy)return;
      state.busy=true;state.quickError="Saving project setup…";
      context.host.requestRender();
      try{
        const result=await send(context,"auto.quick.configure",
          simpleSetup(state)) as {profile:QuickProfile;goals:QuickGoal[]};
        state.quickProfile=result.profile;state.quickGoals=result.goals;
        state.quickSetupDraft=JSON.stringify(result.profile,null,2);
        hydrateSimpleSetup(state,result.profile);
        state.quickSetupLoaded=true;
        state.quickError="Project setup saved. Describe a goal and choose Plan & run.";
      }catch(error){state.quickError="Setup not saved: "+String(error).slice(0,300);}
      finally{state.busy=false;context.host.requestRender();}
    }
    function newQuickRequestId():string{
      // PI WEB may be served over a trusted LAN origin where randomUUID()
      // is unavailable. getRandomValues also works on non-secure origins.
      if(!globalThis.crypto?.getRandomValues)
        throw new Error("Browser cryptographic randomness is unavailable");
      const bytes=new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6]=(bytes[6]!&0x0f)|0x40;
      bytes[8]=(bytes[8]!&0x3f)|0x80;
      const hex=Array.from(bytes,x=>x.toString(16).padStart(2,"0")).join("");
      return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),
        hex.slice(16,20),hex.slice(20)].join("-");
    }
    async function startQuick(context:WorkspacePanelContext){
      const state=stateFor(context);
      if(state.busy||!state.quickProfile||!state.quickGoalText.trim())return;
      let requestId:string;
      try{requestId=state.quickRequestId??newQuickRequestId();}
      catch(error){
        state.quickError="Cannot authorize a run: "+String(error);
        context.host.requestRender();
        return;
      }
      state.quickRequestId=requestId;
      state.busy=true;state.quickError="Submitting Plan & run…";
      context.host.requestRender();
      try{
        const job=await send(context,"auto.quick.start",{
          requestId,goal:state.quickGoalText,
        }) as QuickGoal;
        state.quickGoals=[job,...state.quickGoals.filter(x=>x.requestId!==job.requestId)];
        state.quickError="Request saved. Sol will plan, validate and start automatically.";
      }catch(error){
        state.quickError="Start not confirmed: "+String(error).slice(0,300)+
          ". Refresh status before retrying; the request ID is unchanged.";
      }finally{state.busy=false;context.host.requestRender();}
    }
    async function cancelQuick(context:WorkspacePanelContext,requestId:string){
      const state=stateFor(context);if(state.busy)return;
      state.busy=true;
      try{
        const job=await send(context,"auto.quick.cancel",{requestId}) as QuickGoal;
        state.quickGoals=state.quickGoals.map(g=>g.requestId===job.requestId?job:g);
        state.quickError="Auto-start cancelled. A read-only Sol Session may still finish.";
      }catch(error){state.quickError="Cancel unavailable: "+String(error).slice(0,280);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function openQuickWorkflow(context:WorkspacePanelContext,workflowId:string){
      await refresh(context,workflowId);
      const state=stateFor(context);
      if(state.selected?.definition.id===workflowId)state.view="dag";
      context.host.requestRender();
    }
    function newQuickGoal(context:WorkspacePanelContext){
      const state=stateFor(context);
      state.quickGoalText="";delete state.quickRequestId;
      state.quickError="Ready for a new goal.";context.host.requestRender();
    }
    async function createDemo(context: WorkspacePanelContext) {
      const state = stateFor(context);
      if (state.busy) return;
      state.busy = true; context.host.requestRender();
      try {
        const created = await send(context, "create", DEMO) as WorkflowInstance;
        state.status = "Demo stored in scoped SQLite. No Pi agents have been launched.";
        state.selected = created;
        delete state.selectedTaskId;
      } catch (error) { state.status = String(error); }
      finally { state.busy = false; if (!disposed) { context.host.requestRender(); void refresh(context, "demo-auth"); } }
    }

    function saveGoalRef(context:WorkspacePanelContext,ref:State["goalRef"]):void{
      try{
        if(typeof localStorage==="undefined")return;
        const key="pi-micromanager:goal-ref:"+keyFor(context);
        if(ref)localStorage.setItem(key,JSON.stringify(ref));
        else localStorage.removeItem(key);
      }catch{/* Reference persistence is optional, not an execution authority. */}
    }
    async function proposeGoal(context:WorkspacePanelContext){
      const state=stateFor(context);
      if(state.busy||!state.goalText.trim()||!state.goalProvider.trim()||
        !state.goalModel.trim())return;
      state.busy=true;state.goalStatus="Starting a fresh read-only Sol proposal…";
      context.host.requestRender();
      try{
        const result=await send(context,"auto.propose",{
          goal:state.goalText,provider:state.goalProvider,model:state.goalModel,
          ...(state.goalEffort.trim()?{effort:state.goalEffort.trim()}:{}),
        }) as {draftWorkflowId:string;runId:string;status:string};
        const ref={draftWorkflowId:result.draftWorkflowId,runId:result.runId};
        state.goalRef=ref;saveGoalRef(context,ref);
        state.goalProposalText="";state.goalProposalReady=false;state.goalStatus=result.status;
      }catch(error){state.goalStatus="Goal planning failed: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function checkGoal(context:WorkspacePanelContext){
      const state=stateFor(context),ref=state.goalRef;
      if(state.busy||!ref)return;
      state.busy=true;context.host.requestRender();
      try{
        const result=await send(context,"auto.proposal",ref) as
          {phase:string;proposal:WorkflowDefinition|null;summary:string|null;canAccept:boolean;notice?:string};
        if(result.proposal){
          state.goalProposalText=JSON.stringify(result.proposal,null,2);
          state.goalProposalReady=result.canAccept;
          state.goalStatus=(result.canAccept?"Review before approval: ":
            "Sol submitted a proposal; wait for Run settlement: ")+
            (result.summary??"Validated Task DAG");
        }else state.goalStatus=result.notice??("Proposal phase: "+result.phase+
          ". Wait for the real Pi Session to finish, then check again.");
      }catch(error){state.goalStatus="Cannot read proposal: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function acceptGoal(context:WorkspacePanelContext){
      const state=stateFor(context),ref=state.goalRef;
      if(state.busy||!ref||!state.goalProposalText||!state.goalProposalReady)return;
      state.busy=true;context.host.requestRender();
      try{
        const created=await send(context,"auto.acceptProposal",ref) as WorkflowInstance;
        state.selected=created;
        delete state.selectedTaskId;
        state.workflowDraft=JSON.stringify(created.definition,null,2);
        state.autopilotEnabled=false;state.autopilotConfigured=false;
        delete state.autopilotConfigFor;
        state.goalStatus="Approved "+created.definition.id+
          ". Configure models and tests; automatic Worktree creation is available on Start.";
        delete state.goalRef;state.goalProposalReady=false;saveGoalRef(context,undefined);
        state.workflows=state.workflows.filter(x=>x.definition.id!==created.definition.id).concat(created);
      }catch(error){state.goalStatus="Proposal acceptance failed: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function importWorkflow(context:WorkspacePanelContext){
      const state=stateFor(context);
      if(state.busy)return;
      state.busy=true;context.host.requestRender();
      try{
        const created=await send(context,"create",JSON.parse(state.workflowDraft)) as WorkflowInstance;
        state.selected=created;
        delete state.selectedTaskId;
        state.status="Workflow saved with validated DAG; no Pi Runs launched.";
        state.autopilotConfigured=false;state.autopilotEnabled=false;
        delete state.autopilotConfigFor;
      }catch(error){state.status="Workflow import failed: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function change(context: WorkspacePanelContext, action: WorkflowAction) {
      const state = stateFor(context);
      const workflow = state.selected;
      if (state.busy || !workflow) return;
      state.busy = true; context.host.requestRender();
      try {
        const next = await send(context, "act", { workflowId: workflow.definition.id, expectedRevision: workflow.revision,
          commandId: crypto.randomUUID(), action }) as WorkflowInstance;
        state.selected = next;
        state.workflows = state.workflows.map(x => x.definition.id === next.definition.id ? next : x);
        state.status = "Applied "+action.type+" as revision "+next.revision+
          (state.autopilotConfigured?" (explicit human decision)":" (simulation only)");
      } catch (error) { state.status = String(error); }
      finally { state.busy = false; if (!disposed) context.host.requestRender(); }
    }





    async function adrCommand(context:WorkspacePanelContext,command:"preview"|"stage"|"latest"|"inspect"){
      const state=stateFor(context),workflowId=state.selected?.definition.id;
      if(!workflowId||state.busy)return;
      state.busy=true;context.host.requestRender();
      try{
        let input:unknown;
        if(command==="preview"){
          delete state.adrDraft;
          input={workflowId,targetWorkspaceId:state.adrTargetWorkspaceId.trim(),
            fields:state.adrFields};
        }else if(command==="latest")input={workflowId};
        else input={draftId:state.adrDraft?.id};
        const draft=await send(context,"auto.adr."+command,input) as AdrDraft|null;
        if(draft)state.adrDraft=draft;
        else delete state.adrDraft;
        state.adrStatus=!draft?"No saved ADR proposal yet.":
          draft.state==="staged"?
          "Exact ADR draft bytes staged in the review Worktree. Git commit, Push and PR "+
          "publication remain separate human actions.":
          draft.state==="reserved"?
          "Write reserved or uncertain. Use Inspect; do NOT stage again blindly.":
          "Proposed ADR is read-only. Review exact content, target Git SHA and "+
          "evidence links before staging.";
      }catch(error){state.adrStatus="ADR operation refused: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function captureScreenshot(context:WorkspacePanelContext){
      const state=stateFor(context),workflowId=state.selected?.definition.id;
      if(state.busy||!workflowId||!state.screenshotRunId||
        !state.screenshotPath.trim())return;
      state.busy=true;state.screenshotStatus="Validating actual QC Git commit and screenshot bytes…";
      context.host.requestRender();
      try{
        const record=await send(context,"auto.screenshot.capture",{
          workflowId,runId:state.screenshotRunId,relativePath:state.screenshotPath.trim(),
        }) as {id:string;sha256:string;bytes:number};
        state.screenshotStatus="Captured verified file bytes as immutable screenshot "+
          record.sha256.slice(0,16)+" ("+record.bytes+" bytes).";
        state.journal=await send(context,"auto.journal",{workflowId}) as WorkflowJournal;
        delete state.screenshotPreview;
      }catch(error){state.screenshotStatus="Screenshot capture refused: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function showScreenshot(context:WorkspacePanelContext,id:string){
      const state=stateFor(context),workflowId=state.selected?.definition.id;
      if(state.busy||!workflowId)return;
      state.busy=true;context.host.requestRender();
      try{
        const result=await send(context,"auto.screenshot.preview",{
          workflowId,artifactId:id,
        }) as {artifact:{id:string;sha256:string;mime:string};
          dataUrl:string|null;inlineLimit:number};
        state.screenshotPreview={id:result.artifact.id,
          dataUrl:result.dataUrl,sha256:result.artifact.sha256,mime:result.artifact.mime};
        state.screenshotStatus=result.dataUrl?
          "Displaying immutable image bytes stored privately in this PI WEB host.":
          "Stored screenshot exceeds inline preview limit "+result.inlineLimit+
          " bytes; metadata remains available. No image contents were sent to a model.";
      }catch(error){state.screenshotStatus="Screenshot unavailable: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function loadEvidenceJournal(context:WorkspacePanelContext){
      const s=stateFor(context),workflowId=s.selected?.definition.id;
      if(s.busy||!workflowId)return;
      s.busy=true;context.host.requestRender();
      try{
        const value=await send(context,"auto.journal",{workflowId}) as WorkflowJournal;
        if(value.workflowId!==workflowId)throw new Error("Journal scope changed");
        s.journal=value;
        s.status="Loaded verified journal revision "+value.revision+".";
      }catch(error){s.status="Journal unavailable: "+String(error);}
      finally{s.busy=false;context.host.requestRender();}
    }
    async function retentionCommand(context:WorkspacePanelContext,kind:"preview"|"confirm"){
      const s=stateFor(context);
      if(s.busy)return;
      s.busy=true;context.host.requestRender();
      try{
        if(kind==="preview"){
          delete s.retentionPreview;
          const result=await send(context,"auto.retention.preview",{days:s.retentionDays}) as
            RetentionPreview|null;
          if(!result){s.retentionStatus=
            "No eligible old activity: unresolved workflows, QC evidence and native Pi sessions are protected.";}
          else{
            s.retentionPreview=result;
            s.retentionStatus="Read-only retention preview created. Review before confirmation.";
          }
        }else{
          const plan=s.retentionPreview;
          if(!plan||plan.state!=="prepared")throw new Error("Preview first");
          const done=await send(context,"auto.retention.confirm",{previewId:plan.id}) as RetentionPreview;
          s.retentionPreview=done;
          s.retentionStatus="Pruned "+done.deletedRows+
            " old public activity rows. Workflow, QC evidence and native Pi Sessions are untouched.";
        }
      }catch(error){s.retentionStatus="Retention refused: "+String(error);}
      finally{s.busy=false;context.host.requestRender();}
    }

    function insertAutoManagedWorktrees(context:WorkspacePanelContext){
      const state=stateFor(context);
      if(state.autopilotEnabled)return;
      try{
        const raw=JSON.parse(state.autopilotDraft) as Record<string,unknown>;
        raw.workspaces??={};
        raw.managedWorktrees=true;
        raw.finalization={workspaceId:"auto",autoMerge:true};
        state.autopilotDraft=JSON.stringify(raw,null,2);
        state.autopilotStatus="Automatic Worktrees staged. On explicit Start, "+
          "missing Task Worktrees and the final Worktree will be created and "+
          "their PI WEB identities verified before any Pi Session. Save the configuration first.";
      }catch(error){state.autopilotStatus=String(error);}
      context.host.requestRender();
    }
    function insertFinalWorkspace(context:WorkspacePanelContext){
      const state=stateFor(context);
      if(state.autopilotEnabled||!state.finalWorktreeWorkspaceId.trim())return;
      try{
        const raw=JSON.parse(state.autopilotDraft) as Record<string,unknown>;
        raw.finalization={
          workspaceId:state.finalWorktreeWorkspaceId.trim(),autoMerge:true,
        };
        state.autopilotDraft=JSON.stringify(raw,null,2);
        state.autopilotStatus="Final integration Workspace staged in JSON. "+
          "Verify a distinct clean, linked non-main Git Worktree, then save "+
          "configuration. Final QC and Workflow permissions gate the merge.";
      }catch(error){state.autopilotStatus=String(error);}
      context.host.requestRender();
    }
    async function permissionCommand(context:WorkspacePanelContext,
      kind:"load"|"approved"|"rejected",approvalId?:string){
      const state=stateFor(context),workflowId=state.selected?.definition.id;
      if(state.busy||!workflowId)return;
      state.busy=true;context.host.requestRender();
      try{
        if(kind!=="load"){
          if(!approvalId)throw new Error("Select an exact permission request");
          const receipt=await send(context,"auto.permission.decide",{
            approvalId,decision:kind,
          }) as ApprovalRequest;
          state.permissionStatus=receipt.state+" "+receipt.action+
            " for QC "+receipt.headSha.slice(0,12)+
            ". This decision cannot be reused for another commit.";
        }
        const latest=await send(context,"auto.permissions",{workflowId}) as {
          approvals:ApprovalRequest[];publication:PublishedOperation[];
          convergence:ConvergenceReceipt[];
        };
        state.approvalRequests=latest.approvals;
        state.publishedOperations=latest.publication;
        state.convergenceReceipts=latest.convergence??[];
        if(kind==="load")state.permissionStatus="Loaded persisted publication decisions.";
      }catch(error){state.permissionStatus="Permissions unavailable: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    async function autopilotCommand(context:WorkspacePanelContext,operation:"configure"|"start"|"pause"){
      const state=stateFor(context),workflowId=state.selected?.definition.id;
      if(!workflowId||state.busy)return;
      state.busy=true;state.autopilotStatus="Processing "+operation+"…";context.host.requestRender();
      try{
        const result=await send(context,"auto."+operation,{
          workflowId,...(operation==="configure"?{config:JSON.parse(state.autopilotDraft)}:{}),
        }) as {enabled:boolean;status:string;config?:unknown};
        state.autopilotEnabled=result.enabled;state.autopilotStatus=result.status;
        if(operation==="start"&&result.config)
          state.autopilotDraft=JSON.stringify(result.config,null,2);
        if(operation==="configure"){
          state.autopilotConfigured=true;
          state.autopilotConfigFor=workflowId;
        }
      }catch(error){state.autopilotStatus=String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }

    async function managedWorktreeCommand(context:WorkspacePanelContext,
      action:"preview"|"create"|"inspect"|"status"){
      const state=stateFor(context),workflow=state.selected;
      if(!workflow||state.busy||state.autopilotEnabled)return;
      state.busy=true;context.host.requestRender();
      try{
        const proof=await send(context,"auto.worktree."+action,
          action==="preview"||action==="status"?
          {workflowId:workflow.definition.id,taskId:state.worktreeTaskId}:
          {planId:state.worktreePlan?.id}) as State["worktreePlan"];
        if(!proof){
          delete state.worktreePlan;
          state.worktreeStatus="No saved Worktree plan for this Task.";
          return;
        }
        if(proof.workflowId!==workflow.definition.id||proof.taskId!==state.worktreeTaskId)
          throw new Error("Managed Git worktree scope mismatch");
        state.worktreePlan=proof;
        state.worktreeStatus=proof.stage==="created"?
          "Created and verified. In PI WEB select this new linked Worktree, copy its Workspace ID, "+
          "then insert that ID into the Autopilot configuration.":
          proof.stage==="prepared"?"Git Worktree planned. Review its branch, base SHA and path before creating.":
          "Creation reserved; if the host response was uncertain, inspect it. Do not issue another Git add.";
      }catch(error){state.worktreeStatus="Worktree operation refused: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    function setWorktreeWorkspaceId(context:WorkspacePanelContext){
      const state=stateFor(context),proof=state.worktreePlan;
      if(!proof||proof.stage!=="created"||!state.worktreeWorkspaceId.trim()||
        proof.workflowId!==state.selected?.definition.id)return;
      try{
        const config=JSON.parse(state.autopilotDraft) as
          {workspaces?:Record<string,string>;[key:string]:unknown};
        config.workspaces??={};
        config.workspaces[proof.taskId]=state.worktreeWorkspaceId.trim();
        state.autopilotDraft=JSON.stringify(config,null,2);
        state.worktreeStatus="Workspace ID staged in the JSON configuration. "+
          "Save Autopilot configuration separately before starting execution.";
      }catch(error){state.worktreeStatus="Invalid configuration JSON: "+String(error);}
      context.host.requestRender();
    }
    async function integrationCommand(context:WorkspacePanelContext,taskId:string,
      action:"preview"|"confirm"){
      const state=stateFor(context),workflow=state.selected;
      if(!workflow||state.busy)return;
      state.busy=true;context.host.requestRender();
      try{
        if(action==="preview"){
          delete state.integrationPreview;
          const proof=await send(context,"auto.integration.preview",{
            workflowId:workflow.definition.id,taskId,
            targetWorkspaceId:state.integrationTargetWorkspaceId.trim(),
          }) as NonNullable<State["integrationPreview"]>;
          if(proof.workflowId!==workflow.definition.id||proof.taskId!==taskId)
            throw new Error("Unexpected integration proof scope");
          state.integrationPreview=proof;
          state.integrationStatus="Read-only Git ancestry confirmed. Review both SHAs before finalizing.";
        }else{
          const proof=state.integrationPreview;
          if(!proof||proof.taskId!==taskId||proof.workflowId!==workflow.definition.id)
            throw new Error("Preview the exact Task and Git target first");
          const next=await send(context,"auto.integration.confirm",{
            previewId:proof.id,
          }) as WorkflowInstance;
          state.selected=next;
          state.workflows=state.workflows.map(w=>
            w.definition.id===next.definition.id?next:w);
          state.integrationStatus="Git integration verified; Task advanced to integrated. "+
            "No merge, push or file change was performed by Micromanager.";
          delete state.integrationPreview;
        }
      }catch(error){state.integrationStatus="Integration refused: "+String(error);}
      finally{state.busy=false;context.host.requestRender();}
    }
    function selectTask(context: WorkspacePanelContext, taskId: string) {
      const state = stateFor(context);
      state.selectedTaskId = taskId;
      delete state.integrationPreview;state.integrationStatus="";
      state.interventionMode = "workflow";
      context.host.requestRender();
    }
    function taskLens(context: WorkspacePanelContext, w: WorkflowInstance) {
      const state = stateFor(context);
      const task = state.selectedTaskId ? w.tasks[state.selectedTaskId] : undefined;
      if (!task) return html`<section class="mm-lens" aria-label="Task Lens">
        <strong>Task Lens</strong>
        <p>Choose a task in Cockpit, DAG, or Kanban. Its identity is attached automatically.</p>
      </section>`;
      const pending = w.amendments.find(a => a.targetTaskId === task.spec.id &&
        ["planning", "armed", "activated"].includes(a.status));
      const canHold = task.spec.kind === "implementation" &&
        ["ready", "running", "awaiting_qc"].includes(task.status) && !pending;
      return html`<section class="mm-lens" aria-label="Task Lens">
        <div class="mm-lens-head"><div><strong>Task Lens · ${task.spec.title}</strong>
          <p>Target: ${w.definition.id} / ${task.spec.id} · ${task.status} · QC ${task.qcRounds}/${w.definition.maxQcRounds}</p>
        </div><button @click=${() => { delete state.selectedTaskId; context.host.requestRender(); }}>Close</button></div>
        <div class="mm-modes" role="group" aria-label="Intervention target">
          ${(["workflow", "implementer", "qc"] as const).map(mode => html`<button
            class=${state.interventionMode === mode ? "selected" : ""}
            aria-pressed=${state.interventionMode === mode}
            @click=${() => { state.interventionMode = mode; context.host.requestRender(); }}>
            ${mode === "workflow" ? "Change workflow (Sol)" : mode === "implementer" ? "Steer implementer" : "Steer QC"}
          </button>`)}
        </div>
        ${state.interventionMode === "workflow" ? html`<div class="mm-lens-content">
          <p>Reserve the next post-QC transition now. Sol prepares a typed plan; only the engine can apply its DAG changes.
            Other tasks are unaffected.</p>
          <label for="mm-intervention-text">Instruction to Sol (task target is automatic)</label>
          <textarea id="mm-intervention-text" rows="3" maxlength="4000" .value=${state.interventionDraft}
            ?disabled=${state.busy || !!pending}
            @input=${(e: Event) => { state.interventionDraft = (e.target as HTMLTextAreaElement).value; context.host.requestRender(); }}></textarea>
          <div class="mm-actions">
            <button ?disabled=${state.busy || !canHold || !state.interventionDraft.trim()}
              @click=${() => { void change(context, {
                type: "request_intervention",
                interventionId: "human-" + crypto.randomUUID().replace(/-/g, "").slice(0, 18),
                targetTaskId: task.spec.id, afterQcRunId: "next",
                instruction: state.interventionDraft.trim(),
              }); }}>Reserve next QC barrier</button>
            ${pending && (pending.status === "planning" || pending.status === "armed") ? html`<button
              ?disabled=${state.busy}
              @click=${() => { void change(context, { type: "cancel_amendment", amendmentId: pending.id }); }}>
              Cancel pending intervention</button>` : null}
            ${pending?.status === "planning" && !state.autopilotConfigured ? html`<button ?disabled=${state.busy}
              @click=${() => { void change(context, {
                type: "plan_intervention", interventionId: pending.id,
                rationale: "SIMULATION ONLY: independent root-cause and alternative analysis",
                agents: [
                  { id: "astra", title: "Root cause investigation", role: "architect", model: "configured-astra-model" },
                  { id: "opus", title: "Alternative design investigation", role: "architect", model: "configured-opus-model" },
                ],
              }); }}>Simulate Sol plan (Astra + Opus)</button>` : null}
          </div>
          ${pending ? html`<div class="mm-intervention-state" role="status">
            <strong>Intervention ${pending.id}: ${pending.status}</strong>
            <p>${pending.instruction ?? "Typed diagnostic plan"} · after QC: ${pending.afterQcRunId}</p>
            ${pending.status === "planning" ? html`<p>Barrier is durable.
              ${state.autopilotEnabled?
                "Autopilot launches a fresh read-only Sol planning Run; QC remains held if it finishes first.":
                state.autopilotConfigured?
                  "Autopilot is paused. Start it to run Sol planning; the QC barrier remains armed.":
                  "The demo planner is simulation-only until real Autopilot is configured."}</p>` : null}
            ${pending.planRationale ? html`<p>Plan: ${pending.planRationale}</p>` : null}
          </div>` : null}
        </div>` : html`<div class="mm-lens-content">
          <p>Direct ${state.interventionMode === "qc" ? "QC" : "implementer"} steer will target
            the Pi Session bound to task ${task.spec.id} without routing through Sol.</p>
          <p>The Orchestra panel resolves the current one-shot Run in this Task and
            opens its direct Pi Session composer. This workflow preview never pretends to send a command.</p>
          <button ?disabled=${state.busy} @click=${() => {
            selectOrchestraTask(context,w.definition.id,task.spec.id,
              state.interventionMode === "qc" ? "qc" : "implementer");
            void context.navigate({
              machineId:context.machine.id,
              projectId:context.workspace.projectId,
              workspaceId:context.workspace.id,
              view:"workspace",
              tool:runtimePluginId+":live-runs",
            }).catch(error=>{state.status="Cannot open Orchestra: "+String(error);context.host.requestRender();});
          }}>Open Task's live Run in Orchestra</button>
        </div>`}

        ${task.spec.kind==="implementation"&&task.status==="passed"&&state.autopilotConfigured?
          html`<div class="mm-integration" aria-label="Verify external Git integration">
            <strong>Verify completed Git integration</strong>
            <p>This verification is read-only. First integrate the QC-passed commit into
              another Git Worktree yourself, then select its PI WEB workspace ID.
              Preview checks target HEAD, source ancestry and sealed QC evidence.</p>
            <label>Target workspace ID
              <input maxlength="128" .value=${state.integrationTargetWorkspaceId}
                placeholder="Existing integrated workspace ID"
                ?disabled=${state.busy}
                @input=${(e:Event)=>{
                  state.integrationTargetWorkspaceId=(e.target as HTMLInputElement).value;
                  delete state.integrationPreview;state.integrationStatus="";
                  context.host.requestRender();
                }}/></label>
            <button ?disabled=${state.busy||state.autopilotEnabled||
                !state.integrationTargetWorkspaceId.trim()}
              @click=${()=>void integrationCommand(context,task.spec.id,"preview")}>
              Preview verified Git state</button>
            ${state.integrationPreview?.taskId===task.spec.id?html`
              <div class="mm-integration-proof">
                <p>QC Run: ${state.integrationPreview.qcRunId}</p>
                <p>QC source: <code>${state.integrationPreview.sourceSha}</code></p>
                <p>Target HEAD: <code>${state.integrationPreview.targetHead}</code></p>
                <p>Target workspace: ${state.integrationPreview.targetWorkspaceId}</p>
                <p>Expires: ${new Date(state.integrationPreview.expiresAt).toLocaleTimeString()}</p>
                <button ?disabled=${state.busy||state.autopilotEnabled}
                  @click=${()=>void integrationCommand(context,task.spec.id,"confirm")}>
                  Confirm integration and unblock DAG</button>
              </div>`:null}
            ${state.integrationStatus?html`<p role="status">${state.integrationStatus}</p>`:null}
          </div>`:null}
      </section>`;
    }
    const actionsFor = (context: WorkspacePanelContext, t: TaskState, w: WorkflowInstance) => {
      const act = (action: WorkflowAction) => { void change(context, action); };
      const buttons = [];
      if(stateFor(context).autopilotConfigured){
        // Do not offer simulation transitions for a real automated Workflow.
        // The explicit human resume decision is still supported.
        if(t.status==="held")for(const a of w.amendments.filter(a=>a.targetTaskId===t.spec.id&&
          a.status==="activated"&&a.synthesisTaskId&&w.tasks[a.synthesisTaskId]?.status==="done")){
          buttons.push(html`<button @click=${()=>act({type:"resume_after_diagnosis",
            amendmentId:a.id,decision:"rework"})}>Approve rework</button>`);
          if(t.lastQc?.verdict==="pass")buttons.push(html`<button
            @click=${()=>act({type:"resume_after_diagnosis",amendmentId:a.id,
              decision:"accept_pass"})}>Accept QC pass</button>`);
        }
        return buttons;
      }
      if (t.status === "ready") buttons.push(html`<button @click=${() => act({ type: "start", taskId: t.spec.id })}>Simulate start</button>`);
      if (t.status === "running") buttons.push(t.spec.kind === "implementation"
        ? html`<button @click=${() => act({ type: "implementation_finished", taskId: t.spec.id,
            headSha: `simulation-${t.attempts}`, criteriaRevision: 0, testsPassed: true })}>Simulate tests pass</button>`
        : html`<button @click=${() => act({ type: "complete", taskId: t.spec.id })}>Simulate complete</button>`);
      if (t.status === "awaiting_qc") {
        for (const verdict of ["pass", "fail"] as const) buttons.push(html`<button @click=${() => act({ type: "qc_finalized", taskId: t.spec.id,
          runId: `qc-${t.spec.id}-${t.qcRounds + 1}`, headSha: t.pendingWork?.headSha ?? "", criteriaRevision: t.pendingWork?.criteriaRevision ?? 0,
          attempt: t.pendingWork?.attempt ?? 0, verdict })}>Simulate QC ${verdict}</button>`);
      }
      if (t.status === "held") for (const a of w.amendments.filter(a => a.targetTaskId === t.spec.id && a.status === "activated" && a.synthesisTaskId && w.tasks[a.synthesisTaskId]?.status === "done")) {
        buttons.push(html`<button @click=${() => act({ type: "resume_after_diagnosis", amendmentId: a.id, decision: "rework" })}>Resume implementation</button>`);
      }
      if (t.status === "passed") buttons.push(html`<button @click=${() => act({ type: "integrate", taskId: t.spec.id })}>Simulate integration</button>`);
      return buttons;
    };
    const layout = (w: WorkflowInstance) => {
      const depths = new Map<string, number>();
      const depth = (id: string): number => {
        if (depths.has(id)) return depths.get(id)!;
        const task = w.tasks[id]; if (!task) return 0;
        const n = task.spec.dependsOn.length ? 1 + Math.max(...task.spec.dependsOn.map(d => depth(d.taskId))) : 0;
        depths.set(id, n); return n;
      };
      for (const id of Object.keys(w.tasks)) depth(id);
      const byLevel = new Map<number, string[]>();
      for (const [id, d] of depths) byLevel.set(d, [...byLevel.get(d) ?? [], id]);
      const coords = new Map<string, { x: number; y: number }>();
      for (const [d, ids] of byLevel) ids.forEach((id, i) => coords.set(id, { x: 18 + d * 205, y: 18 + i * 86 }));
      return { coords, width: 235 + Math.max(...depths.values()) * 205, height: 36 + Math.max(...[...byLevel.values()].map(a => a.length)) * 86 };
    };
    return {
      contributions: {
        workspacePanels: [{
          id: "micromanager", title: "Micromanager", order: 50,
          render(context) {
            quickContext=context;
            const state = stateFor(context);
            const w = state.selected;
            const tasks = w ? Object.values(w.tasks) : [];
            return html`<style>${styles}</style><section class="mm">
              <header><h2>pi-micromanager</h2><p>See everything. Hear everything. Steer anything. Welcome to Cognitive Overload!</p></header>
              <aside role="note">DAG/Cockpit demo buttons are simulation-only. Autopilot below is a separate opt-in, real Pi Session executor. No automatic merging or Worktree deletion.</aside>
              <div class="toolbar">
                <button ?disabled=${state.busy} @click=${() => { void refresh(context); }}>Reload</button>
                <button ?disabled=${state.busy} @click=${() => { void createDemo(context); }}>Create/load demo DAG</button>
                <select aria-label="Workflow" @change=${(e: Event) => { const target = e.target as HTMLSelectElement; void refresh(context, target.value); }}>
                  ${state.workflows.map(x => html`<option value=${x.definition.id} ?selected=${x.definition.id === w?.definition.id}>${x.definition.title}</option>`)}
                </select>
              </div>
              <p role="status" aria-live="polite">${state.status}</p>

              <section class="mm-quick" aria-label="Natural-language one-command Autopilot">
                <div class="mm-quick-heading">
                  <div><h3>Tell Sol what to build</h3>
                    <p>One command · Plan → DAG → Pi Runs → QC → GitHub</p></div>
                  <span class="mm-quick-mark">AUTO</span>
                </div>
                <label for="mm-quick-goal">Development goal</label>
                <textarea id="mm-quick-goal" rows="3" maxlength="4000"
                  placeholder="What should the agents build? Include acceptance criteria and constraints…"
                  .value=${state.quickGoalText}
                  ?disabled=${state.busy||state.quickGoals.some(g=>
                    ["reserved","planning","starting","running"].includes(g.phase))}
                  @input=${(e:Event)=>{
                    const goal=(e.target as HTMLTextAreaElement).value;
                    if(goal!==state.quickGoalText)delete state.quickRequestId;
                    state.quickGoalText=goal;context.host.requestRender();
                  }}></textarea>
                ${state.quickProfile?html`
                  <p class="mm-quick-scope">
                    ${state.quickProfile.config.runtime==="durable"?"Pi Durable":"PI WEB native Pi"} · Publish to
                    <strong>${state.quickProfile.config.publication?.remote}/${state.quickProfile.config.publication?.baseBranch}</strong>
                    · PR merge: <strong>${state.quickProfile.permissions.actions?.["github.pr.merge"]??
                      state.quickProfile.permissions.default??"allow"}</strong>
                    · New isolated Worktrees
                  </p>`:html`<p class="mm-quick-scope">
                    First save a project setup below (Pi models, tests, GitHub destination and policy).
                    No modifying work runs until you explicitly select Plan &amp; run.</p>`}
                <div class="mm-actions">
                  <button class="mm-quick-run" ?disabled=${state.busy||!state.quickProfile||
                    !state.quickGoalText.trim()||state.quickGoals.some(g=>
                      ["reserved","planning","starting","running"].includes(g.phase))}
                    @click=${()=>void startQuick(context)}>Plan &amp; run</button>
                  <button ?disabled=${state.busy}
                    @click=${()=>void loadQuick(context)}>Refresh progress</button>
                  ${state.quickGoals.length>0&&!state.quickGoals.some(g=>
                    ["reserved","planning","starting","running"].includes(g.phase))?
                    html`<button ?disabled=${state.busy}
                      @click=${()=>newQuickGoal(context)}>New goal</button>`:null}
                </div>
                ${state.quickGoals.slice(0,1).map(job=>html`
                  <div class="mm-quick-progress" role="status" aria-live="polite">
                    <strong>${job.phase==="reserved"?"Queued":job.phase==="planning"?"Sol is planning":
                      job.phase==="starting"?"Preparing Worktrees":
                      job.phase==="running"?"Autopilot is running":
                      job.phase==="finished"?"Completed":
                      job.phase==="cancelled"?"Cancelled":"Needs attention"}</strong>
                    <p>${job.message}</p>
                    <p class="mm-quick-ref">Goal: ${job.goal.slice(0,180)}</p>
                    <p class="mm-quick-ref">Saved target:
                      ${job.profile.config.publication?.remote}/${job.profile.config.publication?.baseBranch}
                      · merge ${job.profile.permissions.actions?.["github.pr.merge"]??
                        job.profile.permissions.default??"allow"}</p>
                    <p class="mm-quick-ref">Workflow <code>${job.workflowId}</code>
                      · Request <code>${job.requestId.slice(0,8)}</code></p>
                    <div class="mm-quick-steps" aria-label="Pipeline">
                      ${["Plan","Prepare","Execute","Complete"].map((title,index)=>html`
                        <span class=${(job.phase==="finished"?3:
                          job.phase==="running"?2:job.phase==="starting"?1:
                          job.phase==="planning"?0:-1)>=index?
                          "mm-step-done":""}>${title}</span>`)}
                    </div>
                    <div class="mm-actions">
                      ${["reserved","planning"].includes(job.phase)?html`
                        <button ?disabled=${state.busy}
                          @click=${()=>void cancelQuick(context,job.requestId)}>
                          Cancel before code starts</button>`:null}
                      ${["starting","running","finished"].includes(job.phase)?html`
                        <button ?disabled=${state.busy}
                          @click=${()=>void openQuickWorkflow(context,job.workflowId)}>
                          Open DAG</button>`:null}
                    </div>
                  </div>`)}
                <details class="mm-quick-setup" ?open=${!state.quickProfile}>
                  <summary>${state.quickProfile?"Project setup / change settings":
                    "First-time project setup (required)"}</summary>
                  <p>Setup is saved once per selected PI WEB project Workspace.
                    Use a trusted Pi provider and model in the host session daemon.
                    Each new goal gets isolated Git Worktrees.</p>
                  <div class="mm-quick-form">
                    <label>Execution engine
                      <select .value=${state.quickRuntime}
                        ?disabled=${state.busy||state.quickAdvanced}
                        @change=${(e:Event)=>{state.quickRuntime=
                          (e.target as HTMLSelectElement).value as "durable"|"pi-web";
                          context.host.requestRender();}}>
                        <option value="durable">Pi Durable — restart-safe, monitored (default)</option>
                        <option value="pi-web">PI WEB native Pi — compatibility</option>
                      </select></label>
                    <p class="mm-quick-scope">Durable uses provider credentials available
                      to the PI WEB daemon environment, not the browser login.
                      Its conversation is monitored in Orchestra, but is not a native
                      PI WEB Chat Session. Configure backend and model deliberately.</p>
                    <label>Pi provider ID
                      <input maxlength="120" placeholder="Authenticated provider ID"
                        .value=${state.quickSimpleProvider} ?disabled=${state.busy||state.quickAdvanced}
                        @input=${(e:Event)=>{state.quickSimpleProvider=
                          (e.target as HTMLInputElement).value;}} /></label>
                    <label>Model ID for all four roles
                      <input maxlength="160" placeholder="Exact Pi model ID"
                        .value=${state.quickSimpleModel} ?disabled=${state.busy||state.quickAdvanced}
                        @input=${(e:Event)=>{state.quickSimpleModel=
                          (e.target as HTMLInputElement).value;}} /></label>
                    <label>Test executable
                      <input maxlength="256" placeholder="node"
                        .value=${state.quickTestFile} ?disabled=${state.busy||state.quickAdvanced}
                        @input=${(e:Event)=>{state.quickTestFile=
                          (e.target as HTMLInputElement).value;}} /></label>
                    <label>Test arguments (one per line)
                      <textarea rows="2" maxlength="2048" placeholder="--test"
                        .value=${state.quickTestArgs} ?disabled=${state.busy||state.quickAdvanced}
                        @input=${(e:Event)=>{state.quickTestArgs=
                          (e.target as HTMLTextAreaElement).value;}}></textarea></label>
                    <label>Git remote
                      <input maxlength="60" .value=${state.quickRemote}
                        ?disabled=${state.busy||state.quickAdvanced}
                        @input=${(e:Event)=>{state.quickRemote=
                          (e.target as HTMLInputElement).value;}} /></label>
                    <label>Target branch
                      <input maxlength="120" .value=${state.quickBase}
                        ?disabled=${state.busy||state.quickAdvanced}
                        @input=${(e:Event)=>{state.quickBase=
                          (e.target as HTMLInputElement).value;}} /></label>
                    <label>GitHub PR merge permission
                      <select .value=${state.quickMerge} ?disabled=${state.busy||state.quickAdvanced}
                        @change=${(e:Event)=>{state.quickMerge=
                          (e.target as HTMLSelectElement).value as "allow"|"ask"|"deny";
                          context.host.requestRender();}}>
                        <option value="ask">Ask me before merge (safer)</option>
                        <option value="allow">Auto-merge after QC + CI</option>
                        <option value="deny">Draft PR only</option>
                      </select></label>
                  </div>
                  ${state.quickMerge==="allow"&&!state.quickAdvanced?html`
                    <p role="note">Automatic merge is enabled. Verify the GitHub target before saving.</p>`:null}
                  <label class="mm-quick-advanced-toggle">
                    <input type="checkbox" .checked=${state.quickAdvanced}
                      ?disabled=${state.busy}
                      @change=${(e:Event)=>{
                        const next=(e.target as HTMLInputElement).checked;
                        if(next&&!state.quickAdvanced){
                          try{state.quickSetupDraft=
                            JSON.stringify(simpleSetup(state),null,2);}
                          catch{/* Keep last reviewed JSON until simple fields are valid. */}
                        }
                        state.quickAdvanced=next;
                        context.host.requestRender();
                      }}/>
                    Advanced: separate models per role / full configuration JSON
                  </label>
                  ${state.quickAdvanced?html`
                    <label for="mm-quick-config">Advanced project profile (JSON)</label>
                    <textarea id="mm-quick-config" rows="14" spellcheck="false"
                      .value=${state.quickSetupDraft} ?disabled=${state.busy}
                      @input=${(e:Event)=>{state.quickSetupDraft=
                        (e.target as HTMLTextAreaElement).value;}}></textarea>`:null}
                  <p>Plan &amp; run authorizes modifying Pi code work; your
                    saved permission policy, independent QC and GitHub rules remain in force.
                    Only your reviewed setup controls merge rights.</p>
                  <button ?disabled=${state.busy}
                    @click=${()=>void configureQuick(context)}>Save project setup</button>
                </details>
                <p class="mm-quick-feedback" role="status">${state.quickError}</p>
              </section>

              <details class="mm-goal-proposal">
                <summary><strong>Ask Sol to plan a new goal</strong> · read-only proposal</summary>
                <p>Sol creates a structured Task DAG through a real Pi Session. Nothing is
                  executed until you review/accept the proposal and separately start Autopilot.</p>
                <label for="mm-goal-text">Development goal</label>
                <textarea id="mm-goal-text" rows="4" maxlength="4000"
                  placeholder="Describe the feature, constraints and expected result…"
                  .value=${state.goalText} ?disabled=${state.busy}
                  @input=${(e:Event)=>{state.goalText=(e.target as HTMLTextAreaElement).value;
                    context.host.requestRender();}}></textarea>
                <div class="mm-goal-credentials">
                  <label>Pi provider <input maxlength="120" placeholder="Configured provider ID"
                    .value=${state.goalProvider} ?disabled=${state.busy}
                    @input=${(e:Event)=>{state.goalProvider=(e.target as HTMLInputElement).value;
                      context.host.requestRender();}} /></label>
                  <label>Model ID <input maxlength="160" placeholder="Exact model ID"
                    .value=${state.goalModel} ?disabled=${state.busy}
                    @input=${(e:Event)=>{state.goalModel=(e.target as HTMLInputElement).value;
                      context.host.requestRender();}} /></label>
                  <label>Effort (optional) <input maxlength="32" placeholder="Supported effort"
                    .value=${state.goalEffort} ?disabled=${state.busy}
                    @input=${(e:Event)=>{state.goalEffort=(e.target as HTMLInputElement).value;}} /></label>
                </div>
                <div class="mm-actions">
                  <button ?disabled=${state.busy||!state.goalText.trim()||
                    !state.goalProvider.trim()||!state.goalModel.trim()}
                    @click=${()=>void proposeGoal(context)}>Ask Sol (read-only)</button>
                  <button ?disabled=${state.busy||!state.goalRef}
                    @click=${()=>void checkGoal(context)}>Check proposal</button>
                </div>
                <p role="status" aria-live="polite">${state.goalStatus}</p>
                ${state.goalProposalText?html`
                  <label for="mm-goal-preview">Sol's proposed DAG (review before approval)</label>
                  <textarea id="mm-goal-preview" rows="12" readonly spellcheck="false"
                    .value=${state.goalProposalText}></textarea>
                  <div class="mm-actions">
                    <button ?disabled=${state.busy||!state.goalProposalReady} @click=${()=>void acceptGoal(context)}>
                      Approve and save exact proposal</button>
                    <button ?disabled=${state.busy} @click=${()=>{
                      state.workflowDraft=state.goalProposalText;
                      context.host.requestRender();
                    }}>Copy into editable Workflow import</button>
                  </div>`:null}
              </details>
              <details class="mm-workflow-import">
                <summary>Import a real Workflow DAG (JSON)</summary>
                <p>Author a Task DAG here or paste a definition. Server-side validation rejects
                  cycles and unsupported dependencies before saving any workflow.</p>
                <textarea rows="10" spellcheck="false" aria-label="Workflow definition JSON"
                  .value=${state.workflowDraft} ?disabled=${state.busy}
                  @input=${(e:Event)=>{state.workflowDraft=(e.target as HTMLTextAreaElement).value;}}></textarea>
                <button ?disabled=${state.busy} @click=${()=>void importWorkflow(context)}>
                  Validate and save Workflow</button>
              </details>

              ${w?html`<details class="mm-managed-worktree">
                <summary><strong>Manage isolated Git Worktree</strong> · preview before creating</summary>
                <p>Create a new Task branch and linked Git Worktree in Micromanager's own data
                  directory. PI WEB discovers linked Git Worktrees automatically.
                  In managed Autopilot mode, the Workspace ID is resolved and verified on Start.
                  Manual ID entry remains available for legacy configurations.
                  No Worktree is deleted automatically.</p>
                <label>Unstarted implementation Task
                  <select aria-label="Task for managed Git Worktree" .value=${state.worktreeTaskId}
                    ?disabled=${state.busy||state.autopilotEnabled}
                    @change=${(e:Event)=>{
                      state.worktreeTaskId=(e.target as HTMLSelectElement).value;
                      delete state.worktreePlan;state.worktreeStatus="";context.host.requestRender();
                    }}>
                    <option value="">Choose Task</option>
                    ${Object.values(w.tasks).filter(t=>t.spec.kind==="implementation"&&t.attempts===0)
                      .map(t=>html`<option value=${t.spec.id}>${t.spec.title}</option>`)}
                  </select>
                </label>
                <div class="mm-actions">
                  <button ?disabled=${state.busy||state.autopilotEnabled||!state.worktreeTaskId}
                    @click=${()=>void managedWorktreeCommand(context,"preview")}>
                    Preview Worktree</button>
                  <button ?disabled=${state.busy||!state.worktreeTaskId}
                    @click=${()=>void managedWorktreeCommand(context,"status")}>
                    Load saved plan</button>
                  <button ?disabled=${state.busy||state.autopilotEnabled||
                    state.worktreePlan?.stage!=="prepared"}
                    @click=${()=>void managedWorktreeCommand(context,"create")}>
                    Create reviewed Git Worktree</button>
                  <button ?disabled=${state.busy||!state.worktreePlan||
                    state.worktreePlan.stage==="prepared"}
                    @click=${()=>void managedWorktreeCommand(context,"inspect")}>
                    Inspect reserved Worktree</button>
                </div>
                ${state.worktreePlan?html`<div class="mm-worktree-proof">
                  <p>Stage: ${state.worktreePlan.stage}</p>
                  <p>Branch: <code>${state.worktreePlan.branch}</code></p>
                  <p>Base SHA: <code>${state.worktreePlan.baseSha}</code></p>
                  <p>Owned path: <code>${state.worktreePlan.path}</code></p>
                  ${state.worktreePlan.stage==="created"?html`
                    <label>Discovered PI WEB Workspace ID
                      <input maxlength="128" placeholder="Copy from PI WEB Worktree details"
                        .value=${state.worktreeWorkspaceId}
                        @input=${(e:Event)=>{
                          state.worktreeWorkspaceId=(e.target as HTMLInputElement).value;
                          context.host.requestRender();
                        }}/></label>
                    <button ?disabled=${!state.worktreeWorkspaceId.trim()||state.busy}
                      @click=${()=>setWorktreeWorkspaceId(context)}>
                      Insert ID into Autopilot configuration</button>`:null}
                </div>`:null}
                <p role="status" aria-live="polite">${state.worktreeStatus}</p>
              </details>`:null}
              <details class="mm-autopilot">
                <summary><strong>Autopilot · Real Orchestrator</strong>
                  <span>${state.autopilotEnabled?"● Running":"○ Paused / offline"}</span></summary>
                <p>YOLO by default: a configured publication target automatically pushes
                  QC-approved commits and creates Draft GitHub PRs. Workflow permissions can
                  override git.push / github.pr.create to ask or deny. Final PR merge uses the Workflow's merge permission; production
                  deployment remains separately gated. Choose the correct remote,
                  base branch and credentials. Legacy configurations never push unexpectedly.
                  Exact models, linked Worktrees and host tests are still required.</p>
                <label for="mm-auto-config">Autopilot configuration (JSON)</label>
                <p>Opt into automatic provisioning to create missing Task Worktrees
                  and a separate final Worktree at explicit Start. PI WEB discovers Git
                  Worktrees automatically; the host validates their exact identities before
                  admitting any Pi Session. Independent final QC and Workflow permissions
                  gate the GitHub auto-merge.</p>
                <button ?disabled=${state.busy||state.autopilotEnabled}
                  @click=${()=>insertAutoManagedWorktrees(context)}>
                  Auto-provision DAG Worktrees + final GitHub auto-merge (opt in)</button>
                <label>Final integration Workspace ID
                  <input .value=${state.finalWorktreeWorkspaceId}
                    ?disabled=${state.busy||state.autopilotEnabled}
                    placeholder="Existing linked non-main Git Worktree ID"
                    @input=${(e:Event)=>{
                      state.finalWorktreeWorkspaceId=(e.target as HTMLInputElement).value;
                      context.host.requestRender();
                    }}/></label>
                <button ?disabled=${state.busy||state.autopilotEnabled||
                  !state.finalWorktreeWorkspaceId.trim()}
                  @click=${()=>insertFinalWorkspace(context)}>
                  Enable full-DAG integration + YOLO PR auto-merge</button>
                <textarea id="mm-auto-config" rows="12" spellcheck="false"
                  .value=${state.autopilotDraft} ?disabled=${state.busy||state.autopilotEnabled}
                  @input=${(e:Event)=>{state.autopilotDraft=(e.target as HTMLTextAreaElement).value;}}></textarea>
                <div class="mm-actions">
                  <button ?disabled=${state.busy||state.autopilotEnabled||!w}
                    @click=${()=>void autopilotCommand(context,"configure")}>Save configuration</button>
                  <button ?disabled=${state.busy||state.autopilotEnabled||!w}
                    @click=${()=>void autopilotCommand(context,"start")}>Start Autopilot</button>
                  <button ?disabled=${state.busy||!state.autopilotEnabled||!w}
                    @click=${()=>void autopilotCommand(context,"pause")}>Pause admission</button>
                </div>
                <p role="status" aria-live="polite">${state.autopilotStatus}</p>
                <section class="mm-permissions">
                  <strong>Workflow permissions · allow / ask / deny</strong>
                  <p>Default: ${w?.definition.permissions?.default??"allow"} (YOLO).
                    Git integration fast-forwards clean unstarted dependent
                    Worktrees after sealed QC. Divergent branches still require human
                    reconciliation during Task dependency convergence.
                    Final integration is a dedicated Pi Run with final QC;
                    GitHub PR merge is YOLO unless the Workflow overrides it.
                    Edit Workflow JSON before import to change decisions.
                    Strong Pi shell restrictions still require an OS sandbox.</p>
                  <button ?disabled=${state.busy||!w}
                    @click=${()=>void permissionCommand(context,"load")}>
                    Load publication & approvals</button>
                  ${state.approvalRequests.map(a=>html`
                    <article class="mm-permission-request">
                      <p><strong>${a.action}</strong> · ${a.state} · Task ${a.taskId}</p>
                      <p>QC ${a.runId} · <code>${a.headSha}</code></p>
                      <p>Destination: ${a.target}</p>
                      ${a.state==="pending"?html`<div class="mm-actions">
                        <button ?disabled=${state.busy}
                          @click=${()=>void permissionCommand(context,"approved",a.id)}>
                          Approve this exact commit</button>
                        <button ?disabled=${state.busy}
                          @click=${()=>void permissionCommand(context,"rejected",a.id)}>
                          Deny</button>
                      </div>`:null}
                    </article>`)}
                  ${state.publishedOperations.map(x=>html`
                    <article class="mm-permission-request">
                      <p>${x.action} · ${x.state} · Task ${x.taskId}</p>
                      <p>Commit <code>${x.sha}</code></p>
                      ${x.result?html`<p>${x.result}</p>`:null}
                    </article>`)}
                  ${state.convergenceReceipts.map(x=>html`
                    <article class="mm-permission-request">
                      <p>Git fast-forward · ${x.state} · ${x.sourceTaskId}
                        → ${x.targetTaskId}</p>
                      <p>QC ${x.qcRunId}: <code>${x.sourceSha}</code></p>
                      <p>Target ${x.targetWorkspaceId} · Branch ${x.branch}</p>
                    </article>`)}
                  <p role="status">${state.permissionStatus}</p>
                </section>
              </details>
              <nav aria-label="Views">${(["cockpit", "dag", "kanban", "journal"] as const).map(view => html`
                <button class=${state.view === view ? "selected" : ""} @click=${() => { state.view = view; context.host.requestRender(); }}>${view.toUpperCase()}</button>
              `)}</nav>
              ${!w ? html`<p>Create a demo DAG or load a saved workflow.</p>` : html`
                <p>Workflow ${w.definition.id} · revision ${w.revision} · QC max ${w.definition.maxQcRounds}</p>
                ${taskLens(context, w)}
                ${state.view === "cockpit" ? html`
                  <div class="mm-toggles">${roleNames.map(role => html`<label>${role}<select .value=${state.detailByRole[role]}
                     @change=${(e: Event) => { state.detailByRole[role] = (e.target as HTMLSelectElement).value as Detail; context.host.requestRender(); }}>
                    <option value="compact">Compact</option><option value="expanded">Expanded</option></select></label>`)}</div>
                  <div class="mm-grid">${tasks.map(t => html`<article class="mm-card ${state.selectedTaskId === t.spec.id ? "mm-task-selected" : ""}"><h3>${t.spec.title}</h3><small>${t.spec.role} · ${t.status} · attempt ${t.attempts}</small>
                     <button class="mm-intervene" @click=${() => selectTask(context, t.spec.id)}>Intervene in this task</button>
                    ${state.detailByRole[t.spec.role] === "expanded" ? html`<p>Task ${t.spec.id}. Depends on ${t.spec.dependsOn.map(d => `${d.taskId}(${d.gate})`).join(", ") || "nothing"}. QC ${t.qcRounds}/${w.definition.maxQcRounds}.</p>
                    <div class="mm-actions">${actionsFor(context, t, w)}</div>` : null}
                  </article>`)}</div>` : null}
                ${state.view === "dag" ? (() => { const graph = layout(w); return html`<div class="mm-scroll"><svg width=${graph.width} height=${graph.height} viewBox=${`0 0 ${graph.width} ${graph.height}`} role="img" aria-label="Workflow DAG">
                  ${tasks.flatMap(t => t.spec.dependsOn.map(d => { const from = graph.coords.get(d.taskId)!; const to = graph.coords.get(t.spec.id)!; return html`<line x1=${from.x+170} y1=${from.y+28} x2=${to.x} y2=${to.y+28} stroke="currentColor" stroke-opacity=".45" stroke-width="1.6" />`; }))}
                  ${tasks.map(t => { const p = graph.coords.get(t.spec.id)!; return html`<g role="button" tabindex="0" aria-label=${"Intervene in " + t.spec.title} @click=${() => selectTask(context,t.spec.id)} @keydown=${(e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectTask(context,t.spec.id); } }}><rect x=${p.x} y=${p.y} rx="8" width="170" height="55" fill="var(--pi-surface)" stroke="var(--pi-border-muted)" /><text x=${p.x+9} y=${p.y+21} fill="currentColor" font-size="11">${t.spec.title.slice(0,23)}</text><text x=${p.x+9} y=${p.y+39} fill="var(--pi-muted)" font-size="10">${t.status}</text></g>`; })}
                </svg></div>`; })() : null}
                ${state.view === "kanban" ? html`<div class="mm-kanban">${(["blocked", "ready", "running", "awaiting_qc", "held", "passed", "done", "integrated", "needs_human"] as const).map(status => html`
                  <section><strong>${status}</strong>${tasks.filter(t=>t.status===status).map(t=>html`<button class="mm-pill" @click=${() => selectTask(context,t.spec.id)}>${t.spec.title}</button>`)}</section>`)}</div>` : null}

                ${state.view === "journal" ? html`
                  <section class="mm-journal" aria-label="Evidence-linked Workflow journal">
                    <div class="mm-actions">
                      <button ?disabled=${state.busy} @click=${()=>void loadEvidenceJournal(context)}>
                        Load evidence-linked journal</button>
                    </div>
                    ${state.journal?.workflowId===w.definition.id?html`
                      ${state.journal.notes.map(note=>html`<p role="note">${note}</p>`)}
                      <h3>Task and QC evidence</h3>
                      ${state.journal.tasks.map(t=>html`<article class="mm-journal-task">
                        <strong>${t.title}</strong>
                        <p>${t.id} · ${t.status} · attempts ${t.attempts} · QC ${t.qcRounds}</p>
                        ${t.lastQc?html`<p>QC ${t.lastQc.verdict}
                          · Run ${t.lastQc.runId}
                          · Git <code>${t.lastQc.headSha}</code></p>`:null}
                      </article>`)}

                      <h3>Actual QC screenshot evidence</h3>
                      <p>Only explicit, already committed screenshots inside a sealed QC Run's
                        <code>screenshots/</code> directory may be captured. Images can contain
                        secrets: inspect them before selecting Capture. This does not certify QC by itself.</p>
                      <div class="mm-screenshot-capture">
                        <label>Sealed QC Run
                          <select .value=${state.screenshotRunId} ?disabled=${state.busy}
                            @change=${(e:Event)=>{
                              state.screenshotRunId=(e.target as HTMLSelectElement).value;
                              context.host.requestRender();
                            }}>
                            <option value="">Choose a sealed QC Run</option>
                            ${state.journal.runs.filter(r=>r.seat==="qc"&&r.phase==="sealed")
                              .map(r=>html`<option value=${r.runId}>${r.runId}</option>`)}
                          </select>
                        </label>
                        <label>Path relative to that QC Worktree
                          <input maxlength="180" spellcheck="false" .value=${state.screenshotPath}
                            placeholder="screenshots/qc.png" ?disabled=${state.busy}
                            @input=${(e:Event)=>{
                              state.screenshotPath=(e.target as HTMLInputElement).value;
                              context.host.requestRender();
                            }}/></label>
                        <button ?disabled=${state.busy||!state.screenshotRunId||
                          !state.screenshotPath.trim()}
                          @click=${()=>void captureScreenshot(context)}>
                          Capture verified screenshot bytes</button>
                      </div>
                      ${state.journal.screenshots.map(shot=>html`
                        <article class="mm-journal-run">
                          <strong>${shot.relativePath}</strong>
                          <p>QC ${shot.runId} · Git <code>${shot.sourceSha}</code></p>
                          <p>sha256:<code>${shot.sha256}</code> · ${shot.bytes} bytes</p>
                          <button ?disabled=${state.busy}
                            @click=${()=>void showScreenshot(context,shot.id)}>Verify / view image</button>
                          ${state.screenshotPreview?.id===shot.id?
                            (state.screenshotPreview.dataUrl?html`
                              <img class="mm-screenshot-preview"
                                src=${state.screenshotPreview.dataUrl}
                                alt=${"QC screenshot file "+shot.relativePath}/>`:
                              html`<p>File too large for inline image preview.</p>`):null}
                        </article>`)}
                      <p role="status">${state.screenshotStatus}</p>
                      <h3>One-shot Pi Runs (up to 120)</h3>
                      ${state.journal.runs.map(run=>html`<article class="mm-journal-run">
                        <strong>${run.seat} · ${run.runId}</strong>
                        <p>Task ${run.taskId} · ${run.phase} · ${run.updatedAt}</p>
                        ${run.evidence?html`
                          <p>Evidence <code>${run.evidence.ref}</code></p>
                          <p>${run.evidence.summary}</p>
                        `:null}
                      </article>`)}
                    `:html`<p>Load the verified Task/Run evidence references above.</p>`}
                    <h3>Authoritative Workflow events</h3>
                    <div class="mm-events">
                      ${[...w.events].reverse().map(e=>html`<article>
                        <time>${e.at}</time><p><strong>${e.type}</strong> · ${e.message}</p>
                      </article>`)}
                    </div>

                    <details class="mm-adr">
                      <summary>Propose a verified architecture decision (ADR)</summary>
                      <p>This is a human-authored ADR proposal grounded in sealed QC
                        evidence and screenshot SHA references. All Tasks must first
                        be integrated/completed. No Git commit, Push or PR is automatic.</p>
                      <label>Separate, clean review Worktree ID
                        <input maxlength="128" .value=${state.adrTargetWorkspaceId}
                          ?disabled=${state.busy}
                          placeholder="PI WEB linked non-main Worktree ID"
                          @input=${(e:Event)=>{
                            state.adrTargetWorkspaceId=(e.target as HTMLInputElement).value;
                            delete state.adrDraft;context.host.requestRender();
                          }}/></label>
                      ${(["filename","title","context","options","decision","consequences"] as const)
                        .map(key=>html`<label>${key}
                          ${key==="filename"||key==="title"?html`
                            <input maxlength=${key==="filename"?"80":"200"}
                              .value=${state.adrFields[key]}
                              ?disabled=${state.busy}
                              @input=${(e:Event)=>{
                                state.adrFields[key]=(e.target as HTMLInputElement).value;
                                delete state.adrDraft;context.host.requestRender();
                              }}/>`:html`<textarea rows="3" maxlength="4000"
                              .value=${state.adrFields[key]}
                              ?disabled=${state.busy}
                              @input=${(e:Event)=>{
                                state.adrFields[key]=(e.target as HTMLTextAreaElement).value;
                                delete state.adrDraft;context.host.requestRender();
                              }}></textarea>`}
                        </label>`)}
                      <div class="mm-actions">
                        <button ?disabled=${state.busy||state.autopilotEnabled||
                          !state.adrTargetWorkspaceId.trim()}
                          @click=${()=>void adrCommand(context,"preview")}>
                          Preview evidence-backed ADR</button>
                        <button ?disabled=${state.busy}
                          @click=${()=>void adrCommand(context,"latest")}>
                          Recover saved draft</button>
                      </div>
                      ${state.adrDraft?html`<div class="mm-adr-preview">
                        <p>Target Git HEAD: <code>${state.adrDraft.targetHead}</code></p>
                        <p>Content SHA-256: <code>${state.adrDraft.sha256}</code></p>
                        <p>File: docs/adr/${state.adrDraft.filename}</p>
                        <p>Status: ${state.adrDraft.state}</p>
                        <textarea readonly rows="16" spellcheck="false"
                          .value=${state.adrDraft.content}></textarea>
                        <div class="mm-actions">
                          <button ?disabled=${state.busy||state.adrDraft.state!=="prepared"}
                            @click=${()=>void adrCommand(context,"stage")}>
                            Stage exact reviewed ADR file in Git Worktree</button>
                          <button ?disabled=${state.busy}
                            @click=${()=>void adrCommand(context,"inspect")}>
                            Inspect staged/reserved file</button>
                        </div>
                      </div>`:null}
                      <p role="status" aria-live="polite">${state.adrStatus}</p>
                    </details>
                    <details class="mm-retention">
                      <summary>Review old public activity retention (manual)</summary>
                      <p>Only events older than 30 days in fully completed
                        Workflows with sealed Runs and retained evidence qualify.
                        This never deletes Pi Session transcripts, Task state,
                        Worktrees, or QC evidence.</p>
                      <label>Age threshold (days)
                        <input type="number" min="30" max="365" .value=${String(state.retentionDays)}
                          ?disabled=${state.busy}
                          @change=${(e:Event)=>{
                            state.retentionDays=Number((e.target as HTMLInputElement).value);
                            delete state.retentionPreview;state.retentionStatus="";
                            context.host.requestRender();
                          }}/></label>
                      <button ?disabled=${state.busy}
                        @click=${()=>void retentionCommand(context,"preview")}>
                        Preview retention (read-only)</button>
                      ${state.retentionPreview?html`
                        <p>Eligible rows: ${state.retentionPreview.rowCount},
                          retained Run count: ${state.retentionPreview.affectedRuns},
                          approximate bytes: ${state.retentionPreview.estimatedBytes}</p>
                        <p>Preview expires at
                          ${new Date(state.retentionPreview.expiresAt).toLocaleTimeString()}</p>
                        <button ?disabled=${state.busy||state.retentionPreview.state!=="prepared"}
                          @click=${()=>void retentionCommand(context,"confirm")}>
                          Confirm pruning public activity only</button>`:null}
                      <p role="status">${state.retentionStatus}</p>
                    </details>
                  </section>` : null}
              `}
            </section>`;
          },
        }, createLiveRunPanel(html, lifetimeSignal)],
      },
      dispose() { disposed = true;clearInterval(quickTimer);quickContext=undefined;states.clear(); },
    };
  },
};
const styles = `
  .mm { padding: 16px; color: inherit; line-height: 1.5; min-width: 0; }
  .mm h2 { margin: 0; font-size: 18px; }
  .mm header p { margin: 2px 0 16px; font-size: 12px; color: var(--pi-muted); }
  .mm aside { border: 1px solid var(--pi-warning-border); background: var(--pi-warning-surface); padding: 9px; border-radius: 8px; font-size: 12px; }
  .mm button, .mm select { font: inherit; padding: 5px 8px; border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-surface); color: inherit; }
  .mm button:hover:not(:disabled) { background: var(--pi-surface-hover); cursor: pointer; }
  .mm button:disabled { opacity: .4; }
  .mm nav { display:flex; flex-wrap:wrap; gap: 6px; margin:12px 0; }
  .mm nav .selected { border-color: var(--pi-accent-border); color: var(--pi-accent); }
  .mm .toolbar { display:flex; flex-wrap:wrap; gap: 8px; margin-top: 12px; }
  .mm-quick{border:1px solid var(--pi-accent-border);border-radius:12px;
    padding:14px;margin:14px 0;background:var(--pi-surface);min-width:0;}
  .mm-quick-heading{display:flex;justify-content:space-between;gap:12px;align-items:start;}
  .mm-quick-heading h3{margin:0;font-size:15px;}
  .mm-quick-heading p{margin:2px 0 12px;font-size:12px;color:var(--pi-muted);}
  .mm-quick-mark{border-radius:999px;border:1px solid var(--pi-border-muted);
    color:var(--pi-muted);font-size:10px;padding:2px 8px;letter-spacing:.08em;}
  .mm-quick label{display:block;font-size:12px;margin:8px 0 4px;}
  .mm-quick textarea{width:100%;box-sizing:border-box;border:1px solid var(--pi-border-muted);
    border-radius:8px;background:var(--pi-surface);color:inherit;padding:10px;
    resize:vertical;font:inherit;min-width:0;}
  .mm-quick-scope,.mm-quick-feedback{font-size:12px;color:var(--pi-muted);
    overflow-wrap:anywhere;margin:8px 0;}
  .mm-quick-run{background:var(--pi-accent-surface, var(--pi-surface))!important;
    border-color:var(--pi-accent-border)!important;font-weight:600!important;}
  .mm-quick-progress{margin-top:12px;padding:12px;border-radius:9px;
    border:1px solid var(--pi-border-muted);background:var(--pi-surface);}
  .mm-quick-progress p{font-size:12px;overflow-wrap:anywhere;margin:4px 0 8px;}
  .mm-quick-ref{color:var(--pi-muted);}
  .mm-quick-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));
    gap:5px;margin:8px 0 12px;}
  .mm-quick-steps span{font-size:10px;text-align:center;padding:5px 2px;
    border-radius:5px;border:1px solid var(--pi-border-muted);color:var(--pi-muted);}
  .mm-quick-steps .mm-step-done{color:var(--pi-accent);border-color:var(--pi-accent-border);}
  .mm-quick-setup{margin-top:12px;border-top:1px solid var(--pi-border-muted);padding-top:10px;}
  .mm-quick-setup summary{cursor:pointer;font-size:12px;}
  .mm-quick-setup p{font-size:12px;color:var(--pi-muted);}
  .mm-quick-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(195px,1fr));gap:6px 12px;}
  .mm-quick-form label{min-width:0;}
  .mm-quick-form input,.mm-quick-form select{display:block;width:100%;box-sizing:border-box;
    padding:7px;border:1px solid var(--pi-border-muted);border-radius:6px;
    background:var(--pi-surface);color:inherit;font:inherit;}
  .mm-quick-advanced-toggle{display:flex!important;align-items:center;gap:6px;}


  .mm .mm-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:10px; }
  .mm-card { border:1px solid var(--pi-border-muted); border-radius:10px; padding: 10px; min-width:0; }
  .mm-card h3 { margin:0; font-size:13px; }
  .mm-card small, .mm time { color: var(--pi-muted); }
  .mm-card p { font-size:12px; overflow-wrap:anywhere; }
  .mm-actions {display:flex;flex-wrap:wrap;gap:6px;}
  .mm-toggles {display:flex; flex-wrap:wrap;gap:12px; margin:12px 0;font-size:12px;}
  .mm-toggles label {display:flex;gap:5px;align-items:center;}
  .mm-scroll {max-width:100%;overflow:auto;}
  .mm-kanban {display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:8px;}
  .mm-kanban section {border:1px solid var(--pi-border-muted);padding:8px;border-radius:8px;min-height:76px;}
  .mm-pill {background:var(--pi-surface);border-radius:6px;padding:6px;margin-top:7px;font-size:12px;}

  .mm-screenshot-capture{display:flex;flex-wrap:wrap;gap:8px;align-items:end;}
  .mm-screenshot-capture label{display:grid;gap:4px;font-size:12px;}
  .mm-screenshot-capture input,.mm-screenshot-capture select{
    min-width:170px;max-width:100%;padding:6px;color:inherit;
    border:1px solid var(--pi-border-muted);border-radius:6px;background:var(--pi-surface);}
  .mm-screenshot-preview{display:block;max-width:100%;max-height:380px;
    object-fit:contain;border:1px solid var(--pi-border-muted);border-radius:6px;margin-top:8px;}
  .mm-journal h3{font-size:13px;margin:16px 0 6px;}
  .mm-journal-task,.mm-journal-run{border:1px solid var(--pi-border-muted);
    border-radius:8px;padding:9px;margin:7px 0;font-size:12px;overflow-wrap:anywhere;}
  .mm-journal-task p,.mm-journal-run p,.mm-retention p{font-size:12px;color:var(--pi-muted);
    overflow-wrap:anywhere;margin:5px 0;}
  .mm-journal code{font-size:11px;overflow-wrap:anywhere;}

  .mm-adr{border:1px solid var(--pi-border-muted);border-radius:8px;
    padding:10px;margin:14px 0;font-size:12px;}
  .mm-adr summary{cursor:pointer;font-weight:600;}
  .mm-adr p{font-size:12px;color:var(--pi-muted);overflow-wrap:anywhere;}
  .mm-adr label{display:grid;gap:4px;font-size:12px;margin:8px 0;}
  .mm-adr textarea,.mm-adr input{width:100%;box-sizing:border-box;
    border:1px solid var(--pi-border-muted);border-radius:6px;
    padding:8px;background:var(--pi-surface);color:inherit;}
  .mm-adr textarea{resize:vertical;font:12px ui-monospace,monospace;}
  .mm-adr-preview{border:1px dashed var(--pi-border-muted);border-radius:8px;
    padding:8px;margin:10px 0;}
  .mm-adr-preview code{overflow-wrap:anywhere;}
  .mm-retention{border:1px solid var(--pi-border-muted);border-radius:8px;
    padding:10px;margin:14px 0;font-size:12px;}
  .mm-retention summary{cursor:pointer;font-weight:600;}
  .mm-retention label{display:flex;gap:8px;align-items:center;margin:8px 0;}
  .mm-retention input{max-width:100px;padding:6px;border:1px solid var(--pi-border-muted);
    border-radius:6px;background:var(--pi-surface);color:inherit;}
  .mm-events article {border-bottom:1px solid var(--pi-border-muted);padding:7px 0;font-size:12px;}
  .mm-events p {margin:0;}
  .mm-task-selected { outline: 2px solid var(--pi-accent-border); }
  .mm-intervene { font-size: 11px !important; margin-top: 6px; }

  .mm-goal-proposal{border:1px solid var(--pi-border-muted);border-radius:8px;
    padding:10px;margin:12px 0;background:var(--pi-surface);}
  .mm-goal-proposal summary{cursor:pointer;}
  .mm-goal-proposal p{font-size:12px;color:var(--pi-muted);}
  .mm-goal-proposal label{display:block;font-size:12px;margin:8px 0 5px;}
  .mm-goal-proposal textarea{width:100%;box-sizing:border-box;resize:vertical;
    color:inherit;background:var(--pi-surface);border:1px solid var(--pi-border-muted);
    border-radius:6px;padding:8px;font:12px ui-monospace,monospace;}
  .mm-goal-proposal textarea[readonly]{opacity:.88;}
  .mm-goal-credentials{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;}
  .mm-goal-credentials input{width:100%;box-sizing:border-box;background:var(--pi-surface);
    color:inherit;border:1px solid var(--pi-border-muted);border-radius:6px;padding:6px;}


  .mm-managed-worktree{border:1px solid var(--pi-border-muted);border-radius:8px;
    background:var(--pi-surface);padding:10px;margin:12px 0;}
  .mm-managed-worktree summary{cursor:pointer;}
  .mm-managed-worktree p{font-size:12px;color:var(--pi-muted);overflow-wrap:anywhere;}
  .mm-managed-worktree label{display:flex;gap:8px;align-items:center;flex-wrap:wrap;
    font-size:12px;margin:8px 0;}
  .mm-managed-worktree input,.mm-managed-worktree select{color:inherit;
    background:var(--pi-surface);border:1px solid var(--pi-border-muted);
    border-radius:6px;padding:6px;min-width:160px;max-width:100%;}
  .mm-worktree-proof{margin:8px 0;padding:8px;border:1px dashed var(--pi-border-muted);
    border-radius:8px;}
  .mm-worktree-proof code{overflow-wrap:anywhere;font-size:11px;}
  .mm-integration{border:1px solid var(--pi-border-muted);background:var(--pi-surface);
    border-radius:8px;padding:10px;margin:12px 0;font-size:12px;}
  .mm-integration p{color:var(--pi-muted);overflow-wrap:anywhere;}
  .mm-integration label{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
  .mm-integration input{min-width:180px;max-width:100%;background:var(--pi-surface);
    border:1px solid var(--pi-border-muted);border-radius:5px;color:inherit;padding:5px;}
  .mm-integration-proof{margin-top:10px;padding:8px;border:1px dashed var(--pi-border-muted);
    border-radius:7px;}
  .mm-integration-proof code{overflow-wrap:anywhere;font-size:11px;}
  .mm-workflow-import{border:1px solid var(--pi-border-muted);border-radius:8px;
    padding:10px;margin:12px 0;background:var(--pi-surface);}
  .mm-workflow-import summary{cursor:pointer;font-weight:600;}
  .mm-workflow-import p{color:var(--pi-muted);font-size:12px;}
  .mm-workflow-import textarea{width:100%;box-sizing:border-box;resize:vertical;margin:8px 0;
    background:var(--pi-surface);color:inherit;border:1px solid var(--pi-border-muted);
    border-radius:6px;padding:8px;font:12px ui-monospace,monospace;}
  .mm-permissions{border-top:1px solid var(--pi-border-muted);padding:10px 0;margin:12px 0 0;}
  .mm-permissions strong{font-size:13px;}
  .mm-permission-request{padding:9px;border:1px solid var(--pi-border-muted);
    border-radius:8px;margin:8px 0;}
  .mm-permission-request code{font-size:11px;overflow-wrap:anywhere;}
  .mm-permission-request p{font-size:12px;overflow-wrap:anywhere;}
  .mm-autopilot {border:1px solid var(--pi-border-muted);background:var(--pi-surface);
    border-radius:9px;padding:11px;margin:12px 0;}
  .mm-autopilot summary {cursor:pointer;display:flex;align-items:center;gap:10px;justify-content:space-between;}
  .mm-autopilot summary span{font-size:11px;color:var(--pi-muted);}
  .mm-autopilot p{font-size:12px;color:var(--pi-muted);}
  .mm-autopilot label{font-size:12px;display:block;margin:8px 0 5px;}
  .mm-autopilot textarea{width:100%;box-sizing:border-box;min-height:120px;resize:vertical;
    background:var(--pi-surface);border:1px solid var(--pi-border-muted);color:inherit;
    border-radius:6px;font:12px ui-monospace,SFMono-Regular,monospace;padding:9px;}
  .mm-lens { border: 1px solid var(--pi-accent-border); border-radius: 9px; padding: 12px; margin: 12px 0; background: var(--pi-surface); }
  .mm-lens-head { display:flex; justify-content:space-between; align-items:start; gap:8px; }
  .mm-lens-head p,.mm-lens-content p { margin:5px 0 9px; font-size:12px; color:var(--pi-muted); }
  .mm-modes { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
  .mm-modes .selected { border-color:var(--pi-accent-border); color:var(--pi-accent); }
  .mm-lens-content label { display:block; font-size:12px; margin:9px 0 4px; }
  .mm-lens-content textarea { font:inherit; box-sizing:border-box; width:100%; min-height:70px; resize:vertical; padding:8px; background:var(--pi-surface); color:inherit; border:1px solid var(--pi-border-muted); border-radius:6px; }
  .mm-lens-content textarea:disabled { opacity:.55; }
  .mm-intervention-state { margin-top:12px; padding:10px; border:1px solid var(--pi-border-muted); border-radius:6px; }
  .mm-kanban .mm-pill { display:block; width:100%; text-align:left; cursor:pointer; }
  .mm-scroll svg g[role="button"] { cursor:pointer; }
  .mm-scroll svg g[role="button"]:focus-visible { outline:2px solid var(--pi-accent); }

`;
export default plugin;
