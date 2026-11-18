// Frozen contract sample uses the Go standard regexp compiler; this bridge executes it
// directly for the same full corpus. No commands or network effects are run.
package main
import("encoding/json";"os";"regexp")
func main(){var in []struct{Pattern string;Subjects []string};if e:=json.NewDecoder(os.Stdin).Decode(&in);e!=nil{panic(e)};out:=[]any{};for _,c:=range in{r,e:=regexp.Compile(c.Pattern);if e!=nil{out=append(out,map[string]any{"error":e.Error()});continue};matches:=[]bool{};for _,s:=range c.Subjects{matches=append(matches,r.MatchString(s))};out=append(out,map[string]any{"matches":matches})};if e:=json.NewEncoder(os.Stdout).Encode(out);e!=nil{panic(e)}}
