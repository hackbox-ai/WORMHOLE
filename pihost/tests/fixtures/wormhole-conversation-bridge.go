package main
import("context";"encoding/json";"net/http";"net/http/httptest";"os";"regexp";"strings";"sync";"time";"wormhole-reference/db";"wormhole-reference/sidequestion";"github.com/jackc/pgx/v5";"github.com/jackc/pgx/v5/stdlib")
const(maxConversationRequestBytes=64<<10;maxConversationAgentKeyRunes=120;maxConversationTitleRunes=200;maxConversationDeleteBatch=100)
type conversationListItem struct{*db.Conversation;Running bool `json:"running"`}
type conversationDeleteItem struct{ID int64 `json:"id"`;OK bool `json:"ok"`;Error string `json:"error,omitempty"`}
type manager struct{pg *db.DB}
type Server struct{m *manager;chatMu sync.Mutex;chatBusy map[string]bool;chatCancel map[string]context.CancelCauseFunc}
func(s *Server)pg(w http.ResponseWriter)*db.DB{return s.m.pg}
func(s *Server)loadProfileConfig(id int64)(struct{},bool){var key string;e:=s.m.pg.QueryRow("SELECT api_key FROM llm_profiles WHERE id=$1",id).Scan(&key);return struct{}{},e==nil&&key!=""}
func(s *Server)cancelConversation(id int64){}
func(s *Server)cancelSideWhere(f func(sidequestion.Parent)bool){}
func decode(r *http.Request,v any)error{return json.NewDecoder(r.Body).Decode(v)}
func writeJSON(w http.ResponseWriter,status int,v any){w.WriteHeader(status);json.NewEncoder(w).Encode(v)}
func writeErr(w http.ResponseWriter,status int,msg string){writeJSON(w,status,map[string]any{"error":msg})}
func pathInt(r *http.Request,key string)(int64,bool){n,e:=strconv.ParseInt(r.PathValue(key),10,64);return n,e==nil}
func atoiDefault(s string,n int)int{v,e:=strconv.Atoi(s);if e!=nil{return n};return v}
func rfc3339(t time.Time)string{return t.Format(time.RFC3339)}
func i64s(n int64)string{return strconv.FormatInt(n,10)}
func check(e error){if e!=nil{panic(e)}}
func main(){schema:=os.Getenv("WORMHOLE_CONV_SCHEMA");if !regexp.MustCompile(`^codex_conv_ref_[0-9_]+$`).MatchString(schema){panic("invalid isolated schema")};cfg,e:=pgx.ParseConfig(os.Getenv("WORMHOLE_CONV_DSN"));check(e);cfg.RuntimeParams["search_path"]=schema;sql:=stdlib.OpenDB(*cfg);defer sql.Close();raw,e:=os.ReadFile("db/schema.sql");check(e);_,e=sql.Exec(string(raw));check(e);
 var input struct{SQL string;Cases []struct{Method,Path string;Body any}};check(json.NewDecoder(os.Stdin).Decode(&input));_,e=sql.Exec(input.SQL);check(e);
 s:=Server{m:&manager{&db.DB{DB:sql}},chatBusy:map[string]bool{},chatCancel:map[string]context.CancelCauseFunc{}};mux:=http.NewServeMux();
 mux.HandleFunc("GET /api/conversations",s.pgListConversations);mux.HandleFunc("POST /api/conversations",s.pgCreateConversation);mux.HandleFunc("PATCH /api/conversations/{id}",s.pgRenameConversation);mux.HandleFunc("PATCH /api/conversations/{id}/profile",s.pgUpdateConversation);mux.HandleFunc("DELETE /api/conversations/{id}",s.pgDeleteConversation);mux.HandleFunc("POST /api/conversations/delete/batch",s.pgDeleteConversationsBatch);mux.HandleFunc("GET /api/conversations/{id}/messages",s.pgConversationMessages);mux.HandleFunc("GET /api/conversations/{id}/messages/{seq}",s.pgConversationMsgDetail);
 initial,e:=s.m.pg.ConversationTokenSummaries();check(e);out:=[]any{};for _,c:=range input.Cases{body,e:=json.Marshal(c.Body);check(e);req:=httptest.NewRequest(c.Method,c.Path,strings.NewReader(string(body)));w:=httptest.NewRecorder();mux.ServeHTTP(w,req);var v any;check(json.Unmarshal(w.Body.Bytes(),&v));out=append(out,map[string]any{"status":w.Code,"json":v})};summaries,e:=s.m.pg.ConversationTokenSummaries();check(e);check(json.NewEncoder(os.Stdout).Encode(map[string]any{"responses":out,"tokens":summaries,"initial_tokens":initial}))}
