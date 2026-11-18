// Independent compatibility component using Go text/template only.
// Build: GOOS=js GOARCH=wasm go build -trimpath -o template.wasm go-template.go
package main
import("bytes";"encoding/json";"text/template";"text/template/parse";"syscall/js")
type request struct{Template string;Values map[string]string;Mode string}
func invoke(_ js.Value,args []js.Value) any{
 out:=map[string]any{"fields":[]string{}}
 var in request
 if err:=json.Unmarshal([]byte(args[0].String()),&in);err!=nil{out["error"]=err.Error()}else{
  t,err:=template.New("p").Option("missingkey=error").Parse(in.Template)
  if err!=nil{out["syntaxError"]=err.Error()}else{
   fields:=templateFields(t);if fields!=nil{out["fields"]=fields}
   if in.Mode!="parse"{data:=map[string]any{};for k,v:=range in.Values{data[k]=v};var buf bytes.Buffer
    if err=t.Execute(&buf,data);err!=nil{out["error"]=err.Error();out["rendered"]=""}else{out["rendered"]=buf.String()}
   }
  }
 }
 b,_:=json.Marshal(out);return string(b)
}
func main(){js.Global().Set("__gatyushaTemplateCompat",js.FuncOf(invoke));select{}}

func templateFields(t *template.Template) []string {
	seen := map[string]bool{}
	var out []string
	collect := func(p *parse.PipeNode) {
		if p == nil {
			return
		}
		for _, cmd := range p.Cmds {
			for _, arg := range cmd.Args {
				if f, ok := arg.(*parse.FieldNode); ok && len(f.Ident) > 0 && !seen[f.Ident[0]] {
					seen[f.Ident[0]] = true
					out = append(out, f.Ident[0])
				}
			}
		}
	}
	var walk func(n parse.Node)
	walk = func(n parse.Node) {
		switch x := n.(type) {
		case *parse.ListNode:
			if x == nil {
				return
			}
			for _, c := range x.Nodes {
				walk(c)
			}
		case *parse.ActionNode:
			collect(x.Pipe)
		case *parse.IfNode:
			collect(x.Pipe)
			walk(x.List)
			walk(x.ElseList)
		case *parse.RangeNode:
			collect(x.Pipe)
			walk(x.List)
			walk(x.ElseList)
		case *parse.WithNode:
			collect(x.Pipe)
			walk(x.List)
			walk(x.ElseList)
		}
	}
	if t.Tree != nil {
		walk(t.Tree.Root)
	}
	return out
}
