# WORMHOLE prompt template compatibility

Go text/template is a compatibility dependency for existing prompt syntax, not an Agent runtime. All Agent sessions use the current host. The bundled WASM runs in a Node worker thread; a Go executable is not needed at deployment.

Source go-template.go wraps only standard template parsing/rendering and field inspection. GO-LICENSE covers the Go standard library and wasm_exec.cjs. Build metadata pins compiler version and file SHA-256 values.

Rebuild with the recorded Go version:
    GOOS=js GOARCH=wasm go build -trimpath -o template.wasm go-template.go
    cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" wasm_exec.cjs
    cp "$(go env GOROOT)/LICENSE" GO-LICENSE

Run agent-source.test.ts after rebuilding; it compares full HTTP responses with the frozen reference handlers, including syntax/runtime errors and nested templates.
