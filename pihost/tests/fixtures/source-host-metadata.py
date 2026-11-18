from pathlib import Path
import re
import os
root=Path(os.environ.get('WORMHOLE_REFERENCE_ROOT','/root/WORMHOLE-reference'))/'server'
def fun(raw,name):
 marks=list(re.finditer(r'^func (?:\([^\n]+?\) )?(\w+)\(',raw,re.M)); i=next(i for i,m in enumerate(marks) if m[1]==name); body=raw[marks[i].start():marks[i+1].start() if i+1<len(marks) else len(raw)]; end=re.search(r'^}',body,re.M); return body[:end.end()]
a=(root/'orchestration.go').read_text(); p=(root/'platform_tools.go').read_text(); mg=(root/'server_mgmt.go').read_text(); cu=(root/'customtool.go').read_text()
names=['toolListTasks','toolListLLMProfiles','toolSpawnTask','toolPauseTask','toolGetTaskGraph','toolListTaskFindings','toolAddHint','toolGetWorkerTrace','toolListWorkerTraces','toolSearchWorkerTraces','toolGetTaskNodeDetail','toolUpdateFindingReport','toolGetFindingTraffic','toolBindFindingTraffic']
parts=[]
for name in names:
 raw=a if name not in names[-2:] else (root/('finding_traffic.go' if name==names[-2] else 'finding_workflow.go')).read_text()
 body=fun(raw,name); match=re.search(r'\n\s*func\([^\n]*context.Context[^\n]*actool.Result, error\) \{',body)
 assert match,name
 parts.append(body[:match.start()]+'\n func(context.Context,json.RawMessage)(actool.Result,error){return actool.Text("METADATA_ONLY"),nil})\n}')
header='package main\nimport("context";"encoding/json";"fmt";"os";"wormhole-reference/agent";"wormhole-reference/db";actool "github.com/Autumn-27/norma/tool")\ntype Server struct{}\n'
helper='func roTool(n,d string,s map[string]any,r func(context.Context,json.RawMessage)(actool.Result,error))actool.CoreTool{return actool.Build(actool.Spec{Name:n,Description:d,Schema:s,Run:func(c context.Context,p json.RawMessage,_ *actool.ToolContext)(actool.Result,error){return r(c,p)}})}\nfunc wrTool(n,d string,s map[string]any,r func(context.Context,json.RawMessage)(actool.Result,error))actool.CoreTool{return roTool(n,d,s,r)}\n'
platform=[]
for name in ['toolCreateSkill','toolUpdateSkillFile','toolCreateCustomTool','toolUpdateCustomTool','toolCreateMCP','toolUpdateMCP','toolDeleteAssetsByHost']:
 body=fun(p,name); match=re.search(r'\n\s*func\([^\n]*context.Context[^\n]*actool.Result, error\) \{',body); assert match,name
 platform.append(body[:match.start()]+'\n func(context.Context,json.RawMessage)(actool.Result,error){return actool.Text("METADATA_ONLY"),nil})\n}')
allnames=names+['toolCreateSkill','toolUpdateSkillFile','toolCreateCustomTool','toolUpdateCustomTool','toolCreateMCP','toolUpdateMCP','toolDeleteAssetsByHost']
main='func main(){s:=&Server{};out:=[]any{};for _,t:=range []actool.CoreTool{'+','.join('s.'+n+'()' for n in allnames)+'}{out=append(out,map[string]any{"key":t.Name(),"description":t.Description(),"schema":t.InputSchema(),"agents":[]string{"auto"}})};if e:=json.NewEncoder(os.Stdout).Encode(out);e!=nil{panic(e)}}'
Path('/tmp/wormhole-platform-metadata-20261012.go').write_text(header+helper+'\n'.join(fun(a,n) for n in ['strParam','objSchema'])+'\n'+fun(p,'customToolSchema')+'\n'+fun(p,'mcpSchema')+'\n'+'\n'.join(parts+platform)+'\n'+main)
