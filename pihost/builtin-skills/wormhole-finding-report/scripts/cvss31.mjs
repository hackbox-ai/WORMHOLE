#!/usr/bin/env node
// CVSS 3.1 BASE only. Equations and integer rounding: FIRST specification §7.1 / Appendix A.
// https://www.first.org/cvss/v3.1/specification-document
import {pathToFileURL} from 'node:url';

const allowed={AV:'NALP',AC:'LH',PR:'NLH',UI:'NR',S:'UC',C:'HLN',I:'HLN',A:'HLN'};
const weights={AV:{N:0.85,A:0.62,L:0.55,P:0.2},AC:{L:0.77,H:0.44},
  PR_U:{N:0.85,L:0.62,H:0.27},PR_C:{N:0.85,L:0.68,H:0.5},
  UI:{N:0.85,R:0.62},CIA:{H:0.56,L:0.22,N:0}};
export function roundup(value){
  const integer=Math.round(value*100000);
  return integer%10000===0?integer/100000:(Math.floor(integer/10000)+1)/10;
}
export function calculate(vector){
  if(typeof vector!=='string'||!vector.trim())throw new Error("CVSS 3.1 basis vector cannot be empty");
  const parts=vector.trim().toUpperCase().split('/');
  if(parts[0].startsWith('CVSS:')){
    if(parts.shift()!=='CVSS:3.1')throw new Error("Only supports CVSS:3.1");
  }
  const metrics={};
  for(const part of parts){
    const match=/^([A-Z]+):([A-Z])$/.exec(part.trim());
    if(!match||!Object.hasOwn(allowed,match[1])||!allowed[match[1]].includes(match[2]))
      throw new Error("Invalid or non-basic indicator:"+part);
    if(Object.hasOwn(metrics,match[1]))throw new Error("Duplicate indicators:"+match[1]);
    metrics[match[1]]=match[2];
  }
  for(const key of Object.keys(allowed))if(!Object.hasOwn(metrics,key))throw new Error("Missing metrics:"+key);
  const changed=metrics.S==='C',iss=1-(1-weights.CIA[metrics.C])*(1-weights.CIA[metrics.I])*(1-weights.CIA[metrics.A]);
  const impact=changed?7.52*(iss-0.029)-3.25*(iss-0.02)**15:6.42*iss;
  const exploitability=8.22*weights.AV[metrics.AV]*weights.AC[metrics.AC]*weights[changed?'PR_C':'PR_U'][metrics.PR]*weights.UI[metrics.UI];
  const score=impact<=0?0:roundup(Math.min((changed?1.08:1)*(impact+exploitability),10));
  const severity=score===0?'none':score<4?'low':score<7?'medium':score<9?'high':'critical';
  return {vector:'CVSS:3.1/'+Object.keys(allowed).map(k=>k+':'+metrics[k]).join('/'),score,severity,iss,impact,exploitability};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{if(process.argv.length!==3)throw new Error('Usage: node cvss31.mjs "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"');
    console.log(JSON.stringify(calculate(process.argv[2]),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
