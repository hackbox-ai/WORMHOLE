// Standard-library template codec. No Agent runtime dependency.
package main

import("encoding/json";"os";"gatyusha-template-codec/notify")
func main(){var in notify.Request;var out notify.Result;if e:=json.NewDecoder(os.Stdin).Decode(&in);e!=nil{out.Error="模板输入格式无效"}else{out=notify.Run(in)};json.NewEncoder(os.Stdout).Encode(out)}
