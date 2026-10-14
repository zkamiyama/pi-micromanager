/** Production admission checks cannot be relaxed by Workflow permissions. */
import {dirname} from "node:path";
import {PublicationManager as PublicationService} from "./publication-service.js";
import {productionPolicy,assertProductionConfig} from "../security/policy.js";
export {evaluatePrActionsRuns} from "./publication-service.js";
export type {PublishedOperation} from "./publication-service.js";
export class PublicationManager extends PublicationService {
  private readonly stateDirectory:string;
  constructor(options:ConstructorParameters<typeof PublicationService>[0]){
    super(options);this.stateDirectory=dirname(options.path);
  }
  override async step(...args:Parameters<PublicationService["step"]>):ReturnType<PublicationService["step"]>{
    const policy=productionPolicy(this.stateDirectory);
    if(policy)assertProductionConfig(policy,args[0].config,args[1].definition);
    return super.step(...args);
  }
}
