package main
import("encoding/json";"net/http";"net/http/httptest";"os";"regexp";"strconv";"strings";"wormhole-reference/db";"wormhole-reference/intercept";"github.com/jackc/pgx/v5";"github.com/jackc/pgx/v5/stdlib")
type manager struct{pg *db.DB;interceptor *intercept.Interceptor}
func(m *manager)PG()*db.DB{return m.pg}
type Server struct{m *manager}
func(s *Server)pg(http.ResponseWriter)*db.DB{return s.m.pg}
func decode(r *http.Request,out any)error{return json.NewDecoder(r.Body).Decode(out)}
func writeJSON(w http.ResponseWriter,status int,out any){w.WriteHeader(status);_ = json.NewEncoder(w).Encode(out)}
func writeErr(w http.ResponseWriter,status int,message string){writeJSON(w,status,map[string]any{"error":message})}
func pathInt(r *http.Request,name string)(int64,bool){id,e:=strconv.ParseInt(r.PathValue(name),10,64);return id,e==nil}
func atoiDefault(raw string,def int)int{n,e:=strconv.Atoi(raw);if e!=nil{return def};return n}
func check(e error){if e!=nil{panic(e)}}
func main(){schema:=os.Getenv("WORMHOLE_INTERCEPT_SCHEMA");if !regexp.MustCompile(`^codex_intercept_ref_[0-9_]+$`).MatchString(schema){panic("invalid fixture schema")};cfg,e:=pgx.ParseConfig(os.Getenv("WORMHOLE_INTERCEPT_DSN"));check(e);cfg.RuntimeParams["search_path"]=schema;sql:=stdlib.OpenDB(*cfg);defer sql.Close();raw,e:=os.ReadFile("db/schema.sql");check(e);_,e=sql.Exec(string(raw));check(e);d:=&db.DB{DB:sql};s:=&Server{&manager{d,intercept.New(d)}};
 check(d.EnsureLLMUsageTable());var in struct{SQL string;Cases []struct{Method,Path string;Body any}};check(json.NewDecoder(os.Stdin).Decode(&in));_,e=sql.Exec(in.SQL);check(e);out:=[]any{}
 for _,c:=range in.Cases{body,e:=json.Marshal(c.Body);check(e);r:=httptest.NewRequest(c.Method,c.Path,strings.NewReader(string(body)));w:=httptest.NewRecorder();p:=strings.Split(strings.Split(c.Path,"?")[0],"/");if len(p)>4{r.SetPathValue("id",p[4]);r.SetPathValue("taskID",p[4])}
 switch p[3]{
 case "rules":if len(p)==4{if c.Method=="GET"{s.interceptListRules(w,r)}else{s.interceptCreateRule(w,r)}}else if len(p)>5{s.interceptToggleRule(w,r)}else if c.Method=="PUT"{s.interceptUpdateRule(w,r)}else{s.interceptDeleteRule(w,r)}
 case "pending":if len(p)==4{s.interceptListPending(w,r)}else if len(p)>5{s.interceptDecide(w,r)}else{s.interceptGetOne(w,r)}
 case "history":if len(p)==4{s.interceptHistory(w,r)}else{s.interceptDetail(w,r)}
 case "task":s.interceptListTaskItems(w,r)
 case "tool-config":if c.Method=="GET"{s.interceptGetToolConfig(w,r)}else{s.interceptSetToolConfig(w,r)}
 case "judge":if len(p)>4{s.interceptJudgeUsage(w,r)}else if c.Method=="GET"{s.interceptGetJudgeConfig(w,r)}else{s.interceptSetJudgeConfig(w,r)}
 };var value any;check(json.Unmarshal(w.Body.Bytes(),&value));out=append(out,map[string]any{"status":w.Code,"json":value})}
 check(json.NewEncoder(os.Stdout).Encode(out))
}
