# Caching and HTTP parsing

## Cache method
1. Independently test two normal requests for URL/key and record the Age/HIT/Vary/Cache-Control/subject; no cache header is not directly excluded, but the shared cache must be proven.
2. Change an unkeyed input with the same key, and then repeat it with a new clean session without an experimental header; only mark retention supports pollution, and the current response reflection is not enough.
3. Cache spoofing only selects private pages/bills/me, which is more normal and static suffix paths; clean requests without credentials are only established when reading the same private canary.
4. Do not pollute the shared key of the whole site, isolate resources with approval and restore according to TTL/cleanup.

## HTTP/1、HTTP/2
When there is evidence of difference in front-end and back-end parsing, only isolate the service against normal boundaries, CL/TE rejection, and H2→H1 conversion. Timeout/400/length changes are only candidates, independently controlled subsequent requests and service logs demonstrate different resolutions.
http_request/fetch will normalize headers and framing, and cannot claim that the original smuggled bytes have been sent; the tool/isolation environment is missing, that is, BLOCKED. No mixed requests to the production shared connection, no pressure to verify.

## Conclusion
Poor parsing, contamination, cross-identity cache leakage, and permissions effects separate and cannot rise from a delay to a hijack.
