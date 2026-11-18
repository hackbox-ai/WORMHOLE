export const CAUSAL_RELATIONS = ['spawns', 'derived_from', 'yields'];
type Node = {id:string;type:string};
type Edge = {src:string;dst:string;rel:string};
export const pathEdgeKey = (edge:Edge) => JSON.stringify([edge.src,edge.rel,edge.dst]);

/** Trace every incoming causal branch, without pulling in sibling findings,
 * goal proofs or digest membership. The visited set also bounds cyclic data. */
export function findingPaths(nodes:Node[],edges:Edge[],targets=nodes.filter(n=>n.type==='finding').map(n=>n.id)) {
 const valid=new Set(nodes.map(n=>n.id)),incoming=new Map<string,Edge[]>();
 for(const edge of edges)if(valid.has(edge.src)&&valid.has(edge.dst)&&CAUSAL_RELATIONS.includes(edge.rel)){
  const list=incoming.get(edge.dst)??[];list.push(edge);incoming.set(edge.dst,list);
 }
 const nodeIds=new Set(targets.filter(id=>valid.has(id))),edgeKeys=new Set<string>(),queue=[...nodeIds];
 for(let i=0;i<queue.length;i++)for(const edge of incoming.get(queue[i]!)??[]){
  edgeKeys.add(pathEdgeKey(edge));if(!nodeIds.has(edge.src)){nodeIds.add(edge.src);queue.push(edge.src);}
 }
 return {nodeIds,edgeKeys};
}
export function markFindingPaths<N extends Node,E extends Edge>(nodes:N[],edges:E[]){
 const path=findingPaths(nodes,edges);
 return {nodes:nodes.map(n=>path.nodeIds.has(n.id)?{...n,finding_path:true}:n),edges:edges.map(e=>path.edgeKeys.has(pathEdgeKey(e))?{...e,finding_path:true}:e)};
}
