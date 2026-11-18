package main
import("context";"encoding/json";"net/http";"net/http/httptest";"os";"strings";"regexp";"wormhole-reference/db";"wormhole-reference/mcphttp";"github.com/jackc/pgx/v5";"github.com/jackc/pgx/v5/stdlib")
type manager struct{pg *db.DB};type Server struct{m *manager}
func(s *Server)pg(w http.ResponseWriter)*db.DB{return s.m.pg}
func(s *Server)assetStore()*db.AssetStore{return s.m.pg.Assets()}
func(s *Server)companyStore()*db.CompanyStore{return s.m.pg.Companies()}
func jsonStrMap(raw json.RawMessage)map[string]string{var v map[string]string;json.Unmarshal(raw,&v);return v}
func decode(r *http.Request,v any)error{return json.NewDecoder(r.Body).Decode(v)}
func writeJSON(w http.ResponseWriter,status int,v any){w.WriteHeader(status);json.NewEncoder(w).Encode(v)}
func writeErr(w http.ResponseWriter,status int,msg string){writeJSON(w,status,map[string]any{"error":msg})}
func(s *Server)discoverAndCacheMCP(ctx context.Context,m *db.MCPServer)error{c,e:=mcphttp.New(ctx,m.Name,m.URL,jsonStrMap(m.Env),m.Insecure);if e!=nil{return e};defer c.Close();ts,e:=c.Tools(ctx);if e!=nil{return e};tools:=[]db.MCPTool{};for _,t:=range ts{tools=append(tools,db.MCPTool{Name:t.Name(),Description:t.Description()})};return s.m.pg.SaveMCPTools(m.ID,tools)}
func check(e error){if e!=nil{panic(e)}}
func main(){schema:=os.Getenv("WORMHOLE_SYNC_SCHEMA");if !regexp.MustCompile(`^codex_sync_ref_[0-9_]+$`).MatchString(schema){panic("invalid isolated schema")};cfg,e:=pgx.ParseConfig(os.Getenv("WORMHOLE_SYNC_DSN"));check(e);cfg.RuntimeParams["search_path"]=schema;sql:=stdlib.OpenDB(*cfg);defer sql.Close();raw,e:=os.ReadFile("db/schema.sql");check(e);_,e=sql.Exec(string(raw));check(e);s:=Server{&manager{&db.DB{DB:sql}}};var cases []struct{Method,Path string;Body any};check(json.NewDecoder(os.Stdin).Decode(&cases));out:=[]any{};for _,c:=range cases{body,e:=json.Marshal(c.Body);check(e);req:=httptest.NewRequest(c.Method,c.Path,strings.NewReader(string(body)));w:=httptest.NewRecorder();switch strings.Split(strings.Split(c.Path,"?")[0],"/")[4]{case "status":s.syncSSStatus(w,req);case "datasource":s.syncSSDatasource(w,req);case "projects":s.syncSSProjects(w,req);case "tasks":s.syncSSTasks(w,req);case "sync":s.syncSSRun(w,req)};var v any;check(json.Unmarshal(w.Body.Bytes(),&v));out=append(out,map[string]any{"status":w.Code,"json":v})};check(json.NewEncoder(os.Stdout).Encode(out))}
