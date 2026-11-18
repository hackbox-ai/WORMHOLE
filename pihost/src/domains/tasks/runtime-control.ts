/** Stop autonomous execution without cancelling the human summary turn. */
export function applyTaskExecutionControl(
  engine:{pause(id:number):void;stopExecution(id:number):Promise<void>;resume(id:number):void},
  id:number,action:'pause'|'stop'|'resume',
):void | Promise<void> {
  if(action==='pause')engine.pause(id);
  else if(action==='stop')return engine.stopExecution(id);
  else engine.resume(id);
}
