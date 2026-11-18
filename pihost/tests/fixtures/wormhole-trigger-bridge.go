package main
import("encoding/json";"net/http";"os";"regexp";"strconv";"sort";"wormhole-reference/db";"github.com/jackc/pgx/v5";"github.com/jackc/pgx/v5/stdlib")
type manager struct{pg *db.DB}
type Server struct{m *manager;runs []any}
type triggeredRun struct{agentKey,title,message string;taskID int64;mergeable bool;taskDesc,taskGoal string}
func(s *Server)reconcileConcurrency(){}
func(s *Server)pg(http.ResponseWriter)*db.DB{return s.m.pg}
func(s *Server)StartTriggeredRun(key,title,msg string,task int64,merge bool,desc,goal string){r:=triggeredRun{key,title,msg,task,merge,desc,goal};s.runs=append(s.runs,map[string]any{"agentKey":key,"title":title,"message":finalTriggerMessage(r),"taskId":task,"mergeable":merge,"taskDesc":desc,"taskGoal":goal})}
func check(e error){if e!=nil{panic(e)}}
func main(){schema:=os.Getenv("WORMHOLE_TRIGGER_SCHEMA");if !regexp.MustCompile("^codex_trigger_ref_[0-9_]+$").MatchString(schema){panic("invalid fixture schema")};cfg,e:=pgx.ParseConfig(os.Getenv("WORMHOLE_TRIGGER_DSN"));check(e);cfg.RuntimeParams["search_path"]=schema;sql:=stdlib.OpenDB(*cfg);defer sql.Close();raw,e:=os.ReadFile("db/schema.sql");check(e);_,e=sql.Exec(string(raw));check(e);
var in struct{SQL string;Steps []string};check(json.NewDecoder(os.Stdin).Decode(&in));_,e=sql.Exec(in.SQL);check(e);s:=&Server{m:&manager{&db.DB{DB:sql}},runs:[]any{}};sc:=newScheduler(s);sc.init();out:=[]any{}
for i,statement:=range in.Steps{if i==1{sc=newScheduler(s);sc.init()};if statement!=""{_,e=sql.Exec(statement);check(e)};s.runs=[]any{};sc.step();rows,e:=sql.Query("SELECT key,value FROM scheduler_state ORDER BY key");check(e);state:=[]any{};for rows.Next(){var k,v string;check(rows.Scan(&k,&v));if k=="fired_goals"{var ids []int64;check(json.Unmarshal([]byte(v),&ids));strings:=[]string{};for _,id:=range ids{strings=append(strings,strconv.FormatInt(id,10))};sort.Strings(strings);b,e:=json.Marshal(strings);check(e);v=string(b)};state=append(state,map[string]any{"key":k,"value":v})};rows.Close();out=append(out,map[string]any{"runs":s.runs,"state":state})};check(json.NewEncoder(os.Stdout).Encode(out))}
