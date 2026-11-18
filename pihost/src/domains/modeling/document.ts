/** OpenAPI draft handling, adapted from Full-Chain-Sentinel-System (MIT).
 * Attribution and license: ./THIRD_PARTY_LICENSE.txt. */
export type JsonObject = Record<string, unknown>;
export interface BusinessEntity {
  name: string;
  description?: string;
  fields?: { name: string; type?: string; description?: string }[];
  relations?: { target: string; kind?: string; description?: string }[];
}
export const HTTP_METHODS = ['get','post','put','patch','delete','head','options','trace'] as const;
export function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function normalizeTarget(raw: string): string {
  const url = new URL(raw.includes('://') ? raw.trim() : `https://${raw.trim()}`);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new Error("Target must be an HTTP/HTTPS address without credentials");
  if (!url.hostname) throw new Error("Target host cannot be empty");
  // Application paths are significant. Query strings and fragments are not identities.
  url.search = ''; url.hash = '';
  url.pathname = url.pathname.replace(/\/{2,}/g,'/').replace(/\/+$/,'') || '/';
  return url.href.replace(/\/$/,'');
}
export function targetsInText(text: string): string[] {
  const explicit: string[] = [...(text.match(/https?:\/\/[^\s<>"'`，。；、）)\]}]+/gi) ?? [])];
  if (!explicit.length) {
    const hosts = text.match(/(?<![\w@/.-])(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"'`，。；、）)\]}]*)?/gi) ?? [];
    explicit.push(...hosts);
  }
  return [...new Set(explicit.flatMap(v=>{try{return [normalizeTarget(v.replace(/[.,;]+$/,''))];}catch{return [];}}))].slice(0,20);
}
export function skeleton(title: string, target: string): JsonObject {
  return {openapi:'3.0.3',info:{title,version:'1.0.0'},servers:[{url:target}],paths:{}};
}
export function mergeDocument(base: JsonObject, patch: JsonObject): JsonObject {
  const next = {...base,...patch};
  if (object(patch.paths)) {
    const paths: JsonObject = {...(object(base.paths)?base.paths:{})};
    for (const [path,item] of Object.entries(patch.paths)) {
      paths[path] = object(item) ? {...(object(paths[path])?paths[path]:{}),...item} : item;
    }
    next.paths = paths;
  }
  if (object(patch.components)) {
    const components: JsonObject = {...(object(base.components)?base.components:{})};
    for (const [section,entries] of Object.entries(patch.components)) {
      components[section] = object(entries)?{...(object(components[section])?components[section]:{}),...entries}:entries;
    }
    next.components=components;
  }
  return next;
}
export function endpointIndex(doc: JsonObject) {
  const result: {method:string;path:string;summary:string}[]=[];
  for(const [path,item] of Object.entries(object(doc.paths)?doc.paths:{})) {
    if(!object(item))continue;
    for(const method of HTTP_METHODS)if(object(item[method]))result.push({method:method.toUpperCase(),path,summary:String(item[method].summary??item[method].operationId??'')});
  }
  return result;
}
export function validateDocument(doc: unknown, final=false): string[] {
  if(!object(doc))return ["openapi must be a JSON object"];
  const errors:string[]=[];
  if(typeof doc.openapi!=='string'||!/^3\.0\.\d+$/.test(doc.openapi))errors.push("Only accept OpenAPI 3.0.x");
  if(!object(doc.info)||!String(doc.info.title??'').trim()||!String(doc.info.version??'').trim())errors.push("info.title / info.version cannot be empty");
  if(!object(doc.paths))errors.push("paths must be an object");
  else {
    if(Object.keys(doc.paths).length>5000)errors.push("Number of paths cannot exceed 5000");
    for(const [path,item] of Object.entries(doc.paths)) {
      if(!path.startsWith('/')||!object(item)){errors.push(`Invalid path entry:${path}`);continue;}
      for(const method of HTTP_METHODS)if(method in item) {
        const operation=item[method];
        if(!object(operation)||!object(operation.responses)||!Object.keys(operation.responses).length)errors.push(`${method.toUpperCase()} ${path} Missing responses`);
        else for(const [status,response] of Object.entries(operation.responses)){
          const field=method.toUpperCase()+' '+path+'.responses['+JSON.stringify(status)+']';
          if(!/^(default|[1-5](?:\d{2}|XX))$/.test(status))
            errors.push(field+" The key must be HTTP status code or default; summary/tags is placed in the operation layer");
          else if(!object(response))errors.push(field+" Must be a response object");
          else if(!('$ref' in response)&&typeof response.description!=='string')
            errors.push(field+".description must be a string, such as {\"200\":{\"description\":\"Success\"}}; content/schema can be retained within the response object of this status code");
        }
        if(object(operation)&&operation.parameters!==undefined&&!Array.isArray(operation.parameters))errors.push(`${method.toUpperCase()} ${path} parameters must be an array`);
      }
    }
  }
  if(doc.components!==undefined&&!object(doc.components))errors.push("components must be an object");
  if(Buffer.byteLength(JSON.stringify(doc))>512*1024)errors.push("Document exceeds 512KB");
  if(final) {
    const visit=(value:unknown):void=>{
      if(Array.isArray(value)){for(const v of value)visit(v);return;}
      if(!object(value))return;
      if(typeof value.$ref==='string'&&value.$ref.startsWith('#/')) {
        let ref:unknown=doc;
        for(const part of value.$ref.slice(2).split('/'))ref=object(ref)?ref[part.replace(/~1/g,'/').replace(/~0/g,'~')]:undefined;
        if(ref===undefined)errors.push(`Unresolved reference:${value.$ref}`);
      }
      for(const v of Object.values(value))visit(v);
    };
    visit(doc);
    if(!endpointIndex(doc).length)errors.push("There is no interface and the completed version cannot be released; please explain the reason for the blocking and keep the draft");
  }
  return [...new Set(errors)].slice(0,50);
}
export function validateEntities(input: unknown): BusinessEntity[] {
  if(!Array.isArray(input)||input.length>200)throw new Error("entities must be an array of no more than 200 entities");
  const names=new Set<string>();
  for(const raw of input) {
    if(!object(raw)||typeof raw.name!=='string'||!raw.name.trim()||names.has(raw.name.trim()))throw new Error("Business entity name cannot be empty or duplicate");
    names.add(raw.name.trim());
    for(const key of ['fields','relations'])if(raw[key]!==undefined&&(!Array.isArray(raw[key])||raw[key].length>200))throw new Error(`${raw.name}.${key} Must be an array of no more than 200 items`);
    for(const field of (raw.fields??[]) as unknown[])if(!object(field)||typeof field.name!=='string'||!field.name.trim())throw new Error(`${raw.name} There are invalid fields`);
    for(const rel of (raw.relations??[]) as unknown[])if(!object(rel)||typeof rel.target!=='string'||!rel.target.trim())throw new Error(`${raw.name} There is an invalid relationship`);
  }
  return structuredClone(input) as BusinessEntity[];
}
