import type {Pool,PoolClient} from 'pg';
export interface NetworkInput{network_mode?:unknown;network_channel_id?:unknown}
export async function networkBinding(db:Pool|PoolClient,input:NetworkInput){
 const explicit=input.network_mode;
 if(explicit!==undefined&&!['standard','jump'].includes(String(explicit)))throw new Error("Invalid network access mode");
 const rows=(await db.query("SELECT key,value FROM app_settings WHERE key IN ('settings.network_mode','settings.network_channel_id')")).rows;
 const saved=Object.fromEntries(rows.map(r=>[r.key,r.value]));
 const mode=explicit??(saved['settings.network_mode']==='jump'?'jump':'standard');
 if(mode==='standard')return {mode:'standard',channelId:null,version:null};
 const id=Number(input.network_channel_id??saved['settings.network_channel_id']);
 if(!Number.isSafeInteger(id)||id<=0)throw new Error("Please select springboard channel");
 const channel=(await db.query('SELECT id,version,enabled FROM network_channels WHERE id=$1',[id])).rows[0];
 if(!channel?.enabled)throw new Error("Springboard channel does not exist or is disabled");
 return {mode:'jump',channelId:id,version:Number(channel.version)};
}
