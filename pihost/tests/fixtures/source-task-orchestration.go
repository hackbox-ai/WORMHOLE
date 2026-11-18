package main
// Host adapters supply lifecycle callbacks only. The original tool functions,
// graph AddHintTool and db.CreateTaskWithOptions execute without replacements.
import("context";"encoding/json";"os";"regexp";"strconv";"fmt";"time";"sort";"sync";"wormhole-reference/db";"wormhole-reference/agent";actool "github.com/Autumn-27/norma/tool";"github.com/jackc/pgx/v5";"github.com/jackc/pgx/v5/stdlib")
type lifecycle struct{Status string;Paused,Queued bool;PinnedAt int64}
type pinState struct{ProfileID *int64}
type Task struct{ID,Description,Goal,ParentRef string;ExpID,CreatedAt int64;LLMProfileID *int64;Store *db.ExplorationStore;Status string;Paused,Queued bool;PinnedAt int64;Notify func();NotifyHint func([]string)}
func(t *Task)lifecycleSnapshot()lifecycle{return lifecycle{t.Status,t.Paused,t.Queued,t.PinnedAt}}
func(t *Task)llmStateSnapshot()pinState{return pinState{t.LLMProfileID}}
type Manager struct{pg *db.DB;tasks map[string]*Task;notifications [][]string}
func(m *Manager)PG()*db.DB{return m.pg}
func(m *Manager)Assets()*db.AssetStore{return m.pg.Assets()}
func(m *Manager)Task(raw string)(*Task,bool){t,ok:=m.tasks[raw];return t,ok}
func(m *Manager)refresh(){rows,e:=m.pg.ListTasks();if e!=nil{panic(e)};m.tasks=map[string]*Task{};for _,p:=range rows{t:=&Task{ID:strconv.FormatInt(p.ID,10),Description:p.Description,Goal:p.Goal,ParentRef:p.ParentRef,ExpID:p.ExplorationID,CreatedAt:p.CreatedAt.Unix(),LLMProfileID:p.LLMProfileID,Store:m.pg.Exploration(p.ExplorationID),Status:p.Status,Paused:p.Paused,Queued:p.Queued};if p.PinnedAt!=nil{t.PinnedAt=p.PinnedAt.Unix()};t.Notify=func(){};t.NotifyHint=func(texts []string){m.notifications=append(m.notifications,texts)};m.tasks[t.ID]=t}}
func(m *Manager)List()[]*Task{out:=[]*Task{};for _,t:=range m.tasks{out=append(out,t)};sort.Slice(out,func(i,j int)bool{if out[i].PinnedAt!=out[j].PinnedAt{return out[i].PinnedAt>out[j].PinnedAt};a,_:=strconv.Atoi(out[i].ID);b,_:=strconv.Atoi(out[j].ID);return a>b});return out}
func(m *Manager)CreateTaskWithOptions(d,g string,opts db.TaskCreateOptions)(*Task,error){p,e:=m.pg.CreateTaskWithOptions(d,g,opts);if e!=nil{return nil,e};m.refresh();t,_:=m.Task(strconv.FormatInt(p.ID,10));return t,nil}
func(m *Manager)ApplyTaskPause(raw string)error{_,e:=m.pg.Exec("UPDATE tasks SET paused=true,queued=false,queued_at=NULL WHERE id::text=$1",raw);if e==nil{m.tasks[raw].Paused=true;m.tasks[raw].Queued=false};return e}
type Engine struct{started map[string]bool;paused map[string]bool;deleting map[string]bool;pauses int}
func(e *Engine)LastActivity(string)int64{return 0}
func(e *Engine)IsPaused(id string)bool{return e.paused[id]}
func(e *Engine)ReadyFor(*Task)bool{return true}
func(e *Engine)Started(id string)bool{return e.started[id]}
func(e *Engine)IsDeleting(id string)bool{return e.deleting[id]}
func(e *Engine)beginTaskOperation(id string)bool{return !e.IsDeleting(id)}
func(e *Engine)decInflight(string){}
func(e *Engine)Pause(id string,cause error){e.paused[id]=true;e.pauses++}
func(e *Engine)Resume(t *Task){e.paused[t.ID]=false}
type taskControlResult struct{ID,Status string;Paused,Queued bool}
type Server struct{m *Manager;engine *Engine;concMu sync.Mutex;launches []string}
func(s *Server)loadProfileConfig(id int64)(*db.LLMProfile,bool){p,e:=s.m.pg.ProfileByID(id);return p,e==nil&&p!=nil&&p.APIKey!=""}
func(s *Server)launchTask(t *Task,_ string,seed bool){if seed{s.seedFirstIntent(t)};s.launches=append(s.launches,t.ID)}
func(s *Server)cancelTaskChat(string,error){}
func(s *Server)reconcileConcurrency(){}
func isTerminalStatus(v string)bool{return v=="done"||v=="failed"||v=="timeout"}
func roTool(n,d string,s map[string]any,r func(context.Context,json.RawMessage)(actool.Result,error))actool.CoreTool{return actool.Build(actool.Spec{Name:n,Description:d,Schema:s,Run:func(c context.Context,p json.RawMessage,_ *actool.ToolContext)(actool.Result,error){return r(c,p)}})}
func wrTool(n,d string,s map[string]any,r func(context.Context,json.RawMessage)(actool.Result,error))actool.CoreTool{return roTool(n,d,s,r)}
func main(){schema:=os.Getenv("WORMHOLE_ORCHESTRATION_SCHEMA");if !regexp.MustCompile("^codex_orchestration_ref_[0-9_]+$").MatchString(schema){panic("invalid isolated schema")};cfg,e:=pgx.ParseConfig(os.Getenv("WORMHOLE_ORCHESTRATION_DSN"));if e!=nil{panic(e)};cfg.RuntimeParams["search_path"]=schema;sql:=stdlib.OpenDB(*cfg);defer sql.Close();raw,e:=os.ReadFile("db/schema.sql");if e!=nil{panic(e)};if _,e=sql.Exec(string(raw));e!=nil{panic(e)};var in struct{SQL string;Cases []struct{Name,Tool,SQL string;Params map[string]any;Traffic bool}};if e=json.NewDecoder(os.Stdin).Decode(&in);e!=nil{panic(e)};if _,e=sql.Exec(in.SQL);e!=nil{panic(e)};s:=&Server{m:&Manager{pg:&db.DB{DB:sql}},engine:&Engine{started:map[string]bool{"12":true},paused:map[string]bool{},deleting:map[string]bool{}}};s.m.refresh();tools:=map[string]actool.CoreTool{};for _,t:=range []actool.CoreTool{s.toolListTasks(),s.toolListLLMProfiles(),s.toolSpawnTask(),s.toolPauseTask(),s.toolAddHint()}{tools[t.Name()]=t};out:=[]any{};for _,c:=range in.Cases{if c.SQL!=""{if _,e=sql.Exec(c.SQL);e!=nil{panic(e)};s.m.refresh()};flag:=c.Traffic;agent.FindingTrafficBindingEnabled=func()bool{return flag};p,_:=json.Marshal(c.Params);r,e:=tools[c.Tool].Call(context.Background(),p,nil);if e!=nil{panic(e)};var value any;if json.Unmarshal([]byte(r.Flatten()),&value)!=nil{value=r.Flatten()};out=append(out,map[string]any{"name":c.Name,"is_error":r.IsError,"value":value})};state:=map[string]any{};for k,q:=range map[string]string{"tasks":"SELECT id,name,description,goal,status,paused,queued,parent_ref,llm_profile_id,active_llm_profile_id,timeout_seconds,plan_heartbeat_seconds,first_run_at,deadline_at FROM tasks WHERE id>=100 ORDER BY id","relations":"SELECT task_id,source_task_id FROM task_relations ORDER BY task_id,source_task_id","nodes":"SELECT id,exploration_id,kind,payload,priority,state,origin FROM exploration_nodes ORDER BY id","edges":"SELECT exploration_id,src_id,dst_id,rel FROM exploration_edges ORDER BY src_id,dst_id,rel","anchors":"SELECT node_id,asset_id FROM exploration_anchors ORDER BY node_id,asset_id"}{rows,e:=sql.Query("SELECT COALESCE(json_agg(x),'[]'::json) FROM ("+q+") x");if e!=nil{panic(e)};var v json.RawMessage;rows.Next();if e=rows.Scan(&v);e!=nil{panic(e)};rows.Close();state[k]=v};if e=json.NewEncoder(os.Stdout).Encode(map[string]any{"cases":out,"state":state,"launches":s.launches,"notifications":s.m.notifications,"pauses":s.engine.pauses});e!=nil{panic(e)}}
