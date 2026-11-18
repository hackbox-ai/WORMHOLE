# Adapter protocol

`start_reverse_proxy`loads the ES module by default; it only implements conversion, does not create services, and does not issue packages by itself.

```js
export async function encodeRequest({url,method,headers,body}) {
  // body is a UTF-8 string; use another parameter bodyBytes (Buffer) when binary is required. Generate ciphertext and signatures based on real site protocols.
  const wire = encryptAndSign(body); // Implement and verify by yourself
  return {headers:{'content-type':'application/json',...wire.headers},body:wire.body};
}
export async function decodeResponse({url,method,status,headers,body}) {
  return {headers:{'content-type':'application/json'},body:decrypt(body)}; // Implement and verify by yourself
}
```

Function cannot change target URL or method. The returned body must be convertible into a Buffer; headers can be omitted. The host returns the original response state, adjusting the body length and removing compression flags that expire after decryption. The adapter should handle error responses according to the protocol and cannot disguise decryption errors as successes.

The host only releases registered sites, methods and exact paths or path templates. Upstream uses the configured MITM/global proxy and the MITM CA is provided by the host. Internal correlation tags are maintained by the host and stripped before leaving the MITM, and may not be overwritten or sent to the target.

The adapter is a trusted native JS extension, not a malicious script sandbox. Normal network exports are handled by the host runner; do not import network libraries to bypass the development and packaging process.

The input text is body (UTF-8 string) and bodyBytes (Buffer), both of which represent the same text. HTTP response compression is decompressed by the host first; do not treat Buffer as a normal object JSON.stringify. The returned body can be a string or a Buffer; it can additionally return decoded:true/false, and 2xx responses with explicit decoded:false will be reported as an adaptation failure.
