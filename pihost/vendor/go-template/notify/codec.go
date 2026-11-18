// Leaf types retain original text/template reflection names and plain fields.
package notify
import("bytes";"encoding/json";"fmt";"text/template")
type webhookTemplateData struct {Title string;Batch bool;Count int;Items []webhookItem;HomeURL string;SentAt string}
type webhookItem struct {FindingID int64;Name string;VulnClass string;Severity string;SeverityLabel string;Summary string;Assets []string;DetailURL string;FromStatus string;ToStatus string;StatusLabel string}
type Request struct {Op string `json:"op"`;Template string `json:"template"`;Data webhookTemplateData `json:"data"`}
type Result struct {Body string `json:"body"`;Error string `json:"error"`}
func Run(in Request) Result {
 funcs:=template.FuncMap{"json":func(v any)(string,error){b,e:=json.Marshal(v);return string(b),e},"jsons":func(v any)(string,error){b,e:=json.Marshal(v);if e!=nil{return "",e};q,e:=json.Marshal(string(b));if e!=nil{return "",e};return string(q[1:len(q)-1]),nil}}
 t,e:=template.New("body").Funcs(funcs).Option("missingkey=zero").Parse(in.Template)
 if e!=nil{return Result{Error:fmt.Sprintf("请求体模板语法错误: %s",e)}}
 if in.Op=="validate"{return Result{}}
 if in.Op!="render" && in.Op!="wire"{return Result{Error:"未知模板操作"}}
 var out bytes.Buffer;if e=t.Execute(&out,in.Data);e!=nil{return Result{Error:fmt.Sprintf("渲染请求体模板失败: %s",e)}}
 if in.Op=="wire"{if !json.Valid(out.Bytes()){return Result{Error:"请求体模板渲染结果不是合法 JSON"}};wire,e:=json.Marshal(json.RawMessage(out.Bytes()));if e!=nil{return Result{Error:"构造请求体失败"}};return Result{Body:string(wire)}}
 return Result{Body:out.String()}
}
