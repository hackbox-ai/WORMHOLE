import type {Pool} from 'pg';
import {goTrim,validateAssetRule} from './asset-match.ts';
export function assetRuleDTO(row:Record<string,any>,task=false){return {id:Number(row.id),enabled:row.enabled,kind:row.kind||row.scope_kind,pattern:row.pattern||row.value,note:row.note??'',builtin:task?false:row.builtin??false,...(task?{action:row.action}:{}),created_at:row.created_at,updated_at:row.updated_at??row.created_at};}
export class AssetRules {
 constructor(private pool:Pool){}
 async list(taskId?:number){const task=taskId!==undefined;const r=await this.pool.query(task?'SELECT * FROM task_intercept_rules WHERE task_id=$1 ORDER BY action,id':'SELECT * FROM asset_intercept_rules ORDER BY builtin DESC,id DESC',task?[taskId]:[]);return r.rows.map(row=>assetRuleDTO(row,task));}
 async save(input:Record<string,unknown>,taskId?:number,id?:number){
  const error=validateAssetRule(input,taskId!==undefined);if(error)return {status:400,json:{error}};
  const kind=String(input.kind??''),pattern=goTrim(String(input.pattern??'')),note=String(input.note??''),enabled=input.enabled??false,action=input.action||'block',task=taskId!==undefined;
  let r;
  if(task){
   r=id===undefined?await this.pool.query('INSERT INTO task_intercept_rules(task_id,scope_kind,value,kind,pattern,note,enabled,action) VALUES($1,$2,$3,$2,$3,$4,$5,$6) RETURNING *',[taskId,kind,pattern,note,enabled,action]):await this.pool.query('UPDATE task_intercept_rules SET scope_kind=$3,kind=$3,value=$4,pattern=$4,note=$5,enabled=$6,action=$7 WHERE task_id=$1 AND id=$2 RETURNING *',[taskId,id,kind,pattern,note,enabled,action]);
  }else{
   r=id===undefined?await this.pool.query('INSERT INTO asset_intercept_rules(scope_kind,value,kind,pattern,note,enabled,builtin,action) VALUES($1,$2,$1,$2,$3,$4,false,\'block\') RETURNING *',[kind,pattern,note,enabled]):await this.pool.query('UPDATE asset_intercept_rules SET scope_kind=$2,kind=$2,value=$3,pattern=$3,note=$4,enabled=$5,action=\'block\' WHERE id=$1 RETURNING *',[id,kind,pattern,note,enabled]);
  }
  return r.rows[0]?{status:200,json:assetRuleDTO(r.rows[0],task)}:{status:500,json:{error:'sql: no rows in result set'}};
 }
 async remove(id:number,taskId?:number){const r=await this.pool.query(taskId===undefined?'DELETE FROM asset_intercept_rules WHERE id=$1':'DELETE FROM task_intercept_rules WHERE id=$1 AND task_id=$2',taskId===undefined?[id]:[id,taskId]);return {deleted:taskId===undefined?id:!!r.rowCount};}
 async toggle(id:number,enabled:boolean,taskId?:number){await this.pool.query(taskId===undefined?'UPDATE asset_intercept_rules SET enabled=$2 WHERE id=$1':'UPDATE task_intercept_rules SET enabled=$2 WHERE id=$1 AND task_id=$3',taskId===undefined?[id,enabled]:[id,enabled,taskId]);return {ok:true,enabled};}
}
