export type ReportAssessment={prerequisites:string;reproduction:string;evidence:string;verified_impact:string;limitations:string;root_cause:string;remediation:string;retest:string};
export const assessmentFields=['prerequisites','reproduction','evidence','verified_impact','limitations','root_cause','remediation','retest'] as const;
export function checkFindingReport(report:string,assessment:Partial<ReportAssessment>,sources:string[],known:Set<string>,gaps:string[]){
 const issues:string[]=[];
 for(const field of assessmentFields)if(typeof assessment[field]!=='string'||!assessment[field]!.trim())issues.push("Missing quality description:"+field);
 const sections:{title:string;body:string}[]=[];let current:{title:string;body:string}|undefined,inFence=false;
 for(const line of report.split('\n')){
  if(line.trim().startsWith(String.fromCharCode(96).repeat(3))||line.trim().startsWith('~~~'))inFence=!inFence;
  const heading=!inFence?/^#{1,4}\s+(.+)/.exec(line):null;
  if(heading){current={title:heading[1]!,body:''};sections.push(current);}else if(current)current.body+=line+'\n';
 }
 for(const [name,pattern]of [
  ["Prerequisites",/prerequisite|precondition|identity|permission|身份|前置|条件|权限/i],["Reproduction Steps",/reproduc|steps|复现|步骤/i],["Evidence",/evidence|request|response|output|证据|请求|响应|输出/i],
  ["Impact and Limitations",/impact|limitation|影响|危害/i],["Root Cause",/root cause|根因|原因/i],["Remediation",/remediat|recommendation|fix|修复|整改/i],["Retest",/retest|acceptance|复测|验收/i],
 ] as const)if(!sections.some(s=>pattern.test(s.title)&&s.body.trim()))issues.push("Report is missing a nonempty "+name+" section");
 const observed=sections.filter(s=>/overview|verified impact|impact and severity|概述|已验证影响|影响与危害/i.test(s.title)).flatMap(s=>s.body.split(/[。；;\n]|(?<=[.!?])\s+/)).filter(line=>!/(unverified|untested|not (?:yet )?(?:verified|tested|observed)|cannot|does not|未验证|未测试|未实际|尚未|不将|不能|无法|不应)/i.test(line)).join('\n');
 if(/(?:unlimited|unbounded|uncapped|infinite)\b.{0,40}(?:amplification|profit|refund|credit|growth|amount)|(?:profit|refund|credit|amount).{0,30}\b(?:unlimited|unbounded|uncapped|infinite)|无限(?:放大|获利|退款|充值|增长)|无上限(?:退款|充值|获利|金额)/i.test(observed))issues.push("Verified impact claims unlimited effects. State the objects, amounts, and repetitions actually observed, and separate inference from unverified boundaries.");
 if(/(?:loop|repeat|amplification).{0,50}(?:unverified|untested|not (?:yet )?(?:verified|tested|executed))|(?:循环|重复).{0,12}(?:未|尚未).{0,12}(?:验证|执行|测试)/i.test(report)&&/(?:repeatable|repeatable amplification|可重复|可循环|循环放大)/i.test(observed))issues.push("The report claims repeatable amplification while saying repetition is unverified. Remove conflicting verified conclusions.");
 if(/cross[- ](?:user|account|tenant).{0,60}(?:unverified|untested|not (?:yet )?(?:tested|verified))|跨(?:用户|账号|租户).{0,18}(?:未|没有).{0,8}(?:测试|验证)/i.test(report)&&/\b(?:any|all) (?:accounts?|users?|tenants?)\b|任意(?:账号|账户|用户|租户)|所有(?:用户|租户)/i.test(observed))issues.push("Cross-account testing is unverified, but the report claims impact on arbitrary identities. Limit the claim to the identities actually tested.");
 if(/基于已登记证据整理。影响范围|待结合实际根因补充修复措施/.test(report))issues.push("Still contains basic template placeholder instructions");
 if(/(?:-b|--cookie|Authorization:)\s*['"]?(?:\.\.\.|…)(?:['"\s]|$)/i.test(report))issues.push("Use ellipses for recurring authentication parameters, and replaceable credentials and how to obtain them should be stated.");
 if(!sources.length||sources.some(s=>!known.has(s)))issues.push("The actual evidence number read this time must be quoted");
 if(!report.trim())issues.push("Report content is empty");
 return {passed:issues.length===0,issues,status:issues.length?'invalid':gaps.length?'needs_evidence':'completed'};
}
