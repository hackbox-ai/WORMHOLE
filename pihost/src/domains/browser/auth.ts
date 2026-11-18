import type {ToolContext} from '../tools/gate.ts';
type AuthResult={acceptResponse?:(headers:Record<string,unknown>)=>Promise<void>;headers:Record<string,string>;receipt:{environment_id:string;name:string;revision:string;authorization_observed:boolean}};
let resolver:((ctx:ToolContext,id:string,url:string)=>Promise<AuthResult>)|undefined;
export function bindBrowserAuth(value:typeof resolver){resolver=value;}
export async function browserAuth(ctx:ToolContext,id:string,url:string){
 if(!resolver)throw new Error("Task browser authentication is not available");
 return resolver(ctx,id,url);
}
