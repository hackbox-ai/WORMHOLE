/** Asset filter language. Unknown field syntax is bare text;
 * AND binds tighter than OR; values always use PostgreSQL parameters. */
const strings:Record<string,string>=Object.fromEntries(['domain','root_domain','ip','url','page_title','icp','service_name','app_name','bundle_id','category','app_icp','method','service_type','record_type'].map(k=>[k,k]));strings.title='page_title';
const combinedTech="(COALESCE(technologies,'{}'::text[]) || COALESCE(fingerprint_technologies,'{}'::text[]))";
const arrays:Record<string,string>={technology:combinedTech,technologies:combinedTech,tech:combinedTech};
const numbers:Record<string,string>={port:'port',status_code:'status_code',status:'status_code'};
const known=(f:string)=>f in strings||f in arrays||f in numbers||f==='task_id'||f==='company_id';
interface Leaf {field:string;op:string;value:string}
interface Token {kind:string;leaf?:Leaf}
function read(s:string,i:number):[string,number]{if(s[i]==='"'){let end=i+1;while(end<s.length&&s[end]!=='"')end++;return [s.slice(i+1,end),end<s.length?end+1:end];}let end=i;while(end<s.length&&!/\s/.test(s[end]!)&&s[end]!=='('&&s[end]!==')')end++;return [s.slice(i,end),end];}
function tokenize(s:string):Token[]{const out:Token[]=[];let i=0;while(i<s.length){if(/\s/.test(s[i]!)){i++;continue;}if(s[i]==='('||s[i]===')'){out.push({kind:s[i]==='('?'LPAREN':'RPAREN'});i++;continue;}
 const field=s.slice(i).match(/^([a-z_][a-z0-9_]*)(==|!=|>=|<=|>|<|=)/i);if(field&&known(field[1]!.toLowerCase())){const start=i+field[0].length,[value,end]=read(s,start);if(end!==start){out.push({kind:'FIELD',leaf:{field:field[1]!.toLowerCase(),op:field[2]!,value}});i=end;continue;}}
 const [value,end]=read(s,i);if(end===i){i++;continue;}i=end;const upper=value.toUpperCase();out.push(upper==='AND'||upper==='OR'?{kind:upper}:{kind:'BARE',leaf:{field:'',op:'=',value}});
 }out.push({kind:'EOF'});return out;}
export function compileAssetDSL(input:string,base=0):{sql:string;args:unknown[]}{
 if(!input.trim())return {sql:'1=1',args:[]};const tokens=tokenize(input),args:unknown[]=[];let pos=0;
 const peek=()=>tokens[pos]!,next=(v:unknown)=>{args.push(v);return `$${base+args.length}`;};
 function leaf(e:Leaf):string{
  const f=e.field;if(!f){const p=next(`%${e.value}%`);return '('+['domain','root_domain','ip','url','page_title','icp','service_name','app_name','app_description'].map(col=>`${col} ILIKE ${p}`).concat([combinedTech,'bound_domains'].map(col=>`EXISTS (SELECT 1 FROM unnest(${col}) t(v) WHERE v ILIKE ${p})`)).join(' OR ')+')';}
  if(f in numbers||f==='company_id'||f==='task_id'){
   if(!/^[+-]?\d+$/.test(e.value)||!Number.isSafeInteger(Number(e.value)))throw new Error(f==='company_id'||f==='task_id'?`${f} Requires integer value: ${e.value}`:`field ${f} Requires integer value: ${e.value}`);
   const n=Number(e.value);if(f==='task_id')return `${next(n)} = ANY(task_ids)`;if(f==='company_id')return `company_id = ${next(n)}`;
   return `${numbers[f]} ${e.op==='=='?'=':e.op} ${next(n)}`;
  }
  if(f in arrays){const col=arrays[f];if(e.op==='==')return `${next(e.value)} = ANY(${col})`;if(e.op==='!=')return `NOT (${next(e.value)} = ANY(${col}))`;if(e.op==='=')return `EXISTS (SELECT 1 FROM unnest(${col}) t(v) WHERE v ILIKE ${next(`%${e.value}%`)})`;throw new Error(`Array field ${f} Operator not supported ${e.op}`);}
  const col=strings[f];if(e.op==='=')return `${col} ILIKE ${next(`%${e.value}%`)}`;if(e.op==='==')return `${col} = ${next(e.value)}`;if(e.op==='!=')return `${col} NOT ILIKE ${next(`%${e.value}%`)}`;throw new Error(`String field ${f} Operator not supported ${e.op}`);
 }
 function atom():string{const t=peek();if(t.kind==='FIELD'||t.kind==='BARE'){pos++;return leaf(t.leaf!);}if(t.kind==='LPAREN'){pos++;const sql=or();if(peek().kind!=='RPAREN')throw new Error("DSL syntax error: missing closing bracket ')'");pos++;return sql;}if(t.kind==='EOF')throw new Error("DSL syntax error: incomplete expression");throw new Error(`DSL syntax error: unexpected token '${t.kind}'`);}
 function and():string{const parts=[atom()];while(peek().kind==='AND'){pos++;parts.push(atom());}return parts.length===1?parts[0]!:parts.map(p=>`(${p})`).join(' AND ');}
 function or():string{const parts=[and()];while(peek().kind==='OR'){pos++;parts.push(and());}return parts.length===1?parts[0]!:parts.map(p=>`(${p})`).join(' OR ');}
 const sql=or();if(peek().kind!=='EOF')throw new Error(`DSL syntax error: unexpected content '${peek().kind}'`);return {sql,args};
}
