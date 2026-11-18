package main
import("encoding/json";"os";"wormhole-reference/db")
type Case struct{Block,Allow []db.AssetInterceptRule;Domains,IPs,URLs []string}
func main(){var cases []Case;if err:=json.NewDecoder(os.Stdin).Decode(&cases);err!=nil{panic(err)};out:=[]db.AssetGateDecision{};for _,c:=range cases{out=append(out,db.EvaluateAssetGate(c.Block,c.Allow,c.Domains,c.IPs,c.URLs))};if err:=json.NewEncoder(os.Stdout).Encode(out);err!=nil{panic(err)}}
