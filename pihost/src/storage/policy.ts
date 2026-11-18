export interface StoragePolicy {
  enabled:boolean;
  hotDays:number;
  intervalMs:number;
  eventBatchRows:number;
  recordingBatchRows:number;
  orphanGraceDays:number;
  toolInlineBytes:number;
  workerSessionBytes:number;
}
export function storagePolicy(raw:Partial<StoragePolicy>={}):StoragePolicy {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid storage policy object');
  const number=(key:keyof StoragePolicy,fallback:number,min:number,max:number)=>{
    const value=raw[key];
    if(value===undefined)return fallback;
    if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`invalid storage policy: ${key}`);
    return value;
  };
  if(raw.enabled!==undefined&&typeof raw.enabled!=='boolean')throw new Error('invalid storage policy: enabled');
  return {enabled:raw.enabled??true,hotDays:number('hotDays',1,0,3650),intervalMs:number('intervalMs',60000,1000,86400000),
    eventBatchRows:number('eventBatchRows',2000,1,10000),recordingBatchRows:number('recordingBatchRows',8,1,100),
    orphanGraceDays:number('orphanGraceDays',7,1,3650),toolInlineBytes:number('toolInlineBytes',32768,4096,1048576),
    workerSessionBytes:number('workerSessionBytes',8*1024*1024,65536,256*1024*1024)};
}
