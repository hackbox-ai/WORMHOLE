# JS interface, object model and signature restoration

## Identification and prefix
First capture a normal business XHR/fetch and record the entry, method, baseURL, Content-Type, identity source, object field, asynchronous chunk and response shape. Searching only /api/ will miss proxies, dynamic routing and non-standard business entries.

## Operation steps
1. Obtain the entry bundle, dynamic import, webpack chunk, and available source map from the loading list, and establish a URL/content hash/extraction status list; remove duplicates from the same content, and read large packages in batches. The new domain referenced is only used as an asset candidate and does not automatically expand the scope.
2. Search fetch/axios/baseURL, hidden/managed routing, Authorization/token, sign/nonce/timestamp, encryption ID, public key/fixed salt, test configuration; associate actual calls, dead code does not open the interface properly.
3. Trace back the normal request call stack: business parameters → sorting/serialization/encoding → signature → send. Record JSON bytes, sorting, null value, time unit, URL encoding, character set, nonce, key source; first use the original front-end function to generate your own object request.
4. Locally reconstruct the same set of parameters and check the signature input and output byte by byte. After the legal business response is established, the parameters under test are changed and signed again. To encrypt the ID, restore your own ID generation process first, without damaging the ciphertext and inferring permission security.
5. Use method + origin + path template + query parameter name to remove duplicates and retain different methods/states/identities/parameter positions; all digital paths cannot be combined into one measured point.

## Control and criteria
Normal requests, wrong signatures, legal signatures but no test objects are compared respectively. 404/Signature failure means that a valid business experiment has not been established. Public keys, anonymous API keys, and front-end identifiers do not automatically constitute leaks; hidden management routes must follow up on back-end permissions and private data.

## Address and naming summary not listed
When an address containing a high-entropy segment (random token, UUID, hash) appears in the business response, front-end routing table or site map, the dictionary enumeration is structurally invalid for the segment; it is processed by capability link and can only be obtained from the relationship: business flow response, jump reference, message body, configuration reference. When seeing a single sample address, first summarize the naming semantics of each segment (organization, period, type, serial number), and then use similar entities to construct the addresses of adjacent objects; use non-existing entity segments and unauthorized subjects to make negative comparisons to distinguish "404 does not exist" and "403/401 Permission Boundary". The summarized rules are written back together with sample evidence, and unverified structures are not considered reachable; enumeration hit items such as old version interface documents and backup paths first check whether there is new information in the content before deciding whether to follow up.

## Write back
record_fact.detail saves the interface, signature steps, parameter locations, reachability proof and remaining prerequisites, and does not store clear text credentials. Transfer object matrix, authentication chain or injection, never stop at "JS downloaded".
