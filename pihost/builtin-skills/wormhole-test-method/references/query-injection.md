# SQL, NoSQL and query expressions

## Select point
Determine language/type from legitimate requests: search, sort, filter JSON, status enumeration, paging, nested operators, report filtering and parameter-by-parameter records; not only test keywords, but do not blindly add quotes to all path/login inputs.

## Verify
1. Prepare a unique canary for your own records, which can be found by normal queries, but cannot be found if there is no mark; lock the identity, snapshot, paging limit and cache.
2. Quotation mark exceptions, 500, total changes, and database names are only used as clues. Construct a true/false condition pairing of the legal context, limit only own data and small paging, and observe whether the canary changes according to the conditions.
3. Add normal/invalid syntax comparison to distinguish filter word matching, business verification and server-side interpretation; prohibit unlimited OR and whole database export as proof.
4. NoSQL compares normal scalars with the objects/arrays, $ne/$gt and other operators accepted by the actual parser. The results need to change the limited test set; storing/echoing them as they are does not count as execution.
5. ORM/HQL/ES/sorting expressions select syntax according to the actual sink. Failure of SQL payload does not mean that other languages ​​​​are safe.
6. The time type must be paired with normal/experimental requests and jitter baseline, short delay, small sample budget, excluding retry/current limiting/network; a slow response is not confirmed.

## Criterion
Repeatable query semantics changes + independent canary supports injection; error reporting/echoing is not enough. Only documented read and write capabilities are reported, and full library leaks/RCE are not directly inferred from injection candidates.
