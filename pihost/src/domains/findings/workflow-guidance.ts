import type {ToolDefinition} from '@earendil-works/pi-coding-agent';
import {findingIDGuidance} from './reads.ts';
import notes from './evidence-guidance.json' with {type:'json'};
function strip(schema:Record<string,any>){const s=structuredClone(schema);if(s.properties){delete s.properties.traffic_refs;delete s.properties.evidence_hint_id;if(s.properties.hints?.items)s.properties.hints.items=strip(s.properties.hints.items);}if(s.required)s.required=s.required.filter((k:string)=>!['traffic_refs','evidence_hint_id'].includes(k));return s;}
/** Finding workflow guidance and tool advertisement. Execution
 * still rechecks the setting, so stale sessions cannot auto-bind after toggle. */
export function findingWorkflow(tools:ToolDefinition[],enabled:boolean){
 if(!enabled)return{tools:tools.filter(t=>t.name!=='bind_finding_traffic').map(t=>['report_finding','add_hint','add_task_hint'].includes(t.name)?{...t,parameters:strip(t.parameters as Record<string,any>)}:t),guidance:''};
 const names=new Set(tools.map(t=>t.name)),out=tools.map(t=>({...t,description:t.description+(t.name==='report_finding'?notes.decorations.report_finding:['add_hint','add_task_hint'].includes(t.name)?notes.decorations.add_hint:['get_finding_traffic','bind_finding_traffic','list_findings','list_task_findings','node_detail','get_task_node_detail','update_finding_report'].includes(t.name)?findingIDGuidance:'')}));let guidance='';
 if(['report_finding','add_task_hint','add_hint'].some(n=>names.has(n))){guidance=notes.handoff;if(names.has('add_task_hint')&&!names.has('add_hint'))guidance+=notes.platform;if(names.has('prove_goal')||names.has('goal_met'))guidance+=notes.goal;}
 if(['update_finding_report','bind_finding_traffic','get_finding_traffic'].every(n=>names.has(n)))guidance+=notes.reporter;
 if(guidance||names.has('get_finding_traffic')||names.has('update_finding_report'))guidance+=findingIDGuidance;
 return{tools:out,guidance};
}
