/** Compare two observations of the same task. Signed byte changes can reflect
 * compaction, so decreases are reported rather than clamped to zero. */
export function performanceInterval(before:any,after:any){
  for(const snapshot of [before,after])if(snapshot?.format!=='wormhole-task-performance'||snapshot.version!==1)throw new Error('unsupported task performance snapshot');
  if(String(before.task?.id)!==String(after.task?.id))throw new Error('interval snapshots must belong to the same task');
  const intervalMs=Date.parse(after.capturedAt)-Date.parse(before.capturedAt);
  if(!Number.isFinite(intervalMs)||intervalMs<=0)throw new Error('snapshots must have increasing capture times');
  const paths={modelCalls:['model','calls'],inputTokens:['model','input_tokens'],outputTokens:['model','output_tokens'],
    toolCalls:['tools','calls'],eventRows:['storage','events','rows'],eventPayloadFieldBytes:['storage','events','live_payload_field_bytes'],
    coldFrameBytes:['storage','archives','frame_bytes'],recordingPackedFieldBytes:['storage','recordings','packed_field_bytes'],
    artifactStoredBytes:['artifacts','unique_stored_bytes']} as const;
  const delta:Record<string,string>={},approximateRatesPerHour:Record<string,number>={};
  const field=(snapshot:any,path:readonly string[])=>{let value=snapshot;for(const key of path)value=value?.[key];if(typeof value!=='string'||!/^\d+$/.test(value))throw new Error('invalid performance counter: '+path.join('.'));return BigInt(value);};
  for(const [name,path] of Object.entries(paths)){
    const difference=field(after,path)-field(before,path);delta[name]=String(difference);approximateRatesPerHour[name]=Number(difference)*3600000/intervalMs;
  }
  return {format:'wormhole-task-performance-interval',version:1,taskId:String(after.task.id),from:before.capturedAt,to:after.capturedAt,intervalMs,delta,approximateRatesPerHour,
    interpretation:['Signed changes include retention, compaction and explicit deletions','Field/frame bytes exclude table indexes, manifests, WAL, backups and workspace files','Rates describe this observation interval, not a prediction','Outcome counts and duplicate arguments do not establish reasoning quality']};
}
