# Reverse and code analysis

## Configure analysis capabilities

Configure capabilities such as session limit, source code indexing and automatic discovery on the reverse engineering and code analysis page. The source code index is used for static auditing, and automatic identification can generate candidate clues for the source code or installation package obtained in the task.

Analysis session cap limits concurrently resident sessions. Whether the external analysis service is available should be confirmed by combining the connection results and call records.

## How to use Worker

Worker calls relevant tools or skills as needed based on the obtained JS, source code, installation package or protocol materials. Automatically triggering shutdown can still be explicitly initiated by the Worker in applicable scenarios.

White box capabilities are accessed through the service API. The reachability, authentication, input materials and return results of the service need to be checked; configuring the client cannot replace the deployment service.

## From clues to evidence

Staticly discovered interfaces, key candidates, calling relationships or risk points need to be verified based on the authorization scope. For encrypted interfaces, check whether the reverse proxy and traffic records are connected in series, and retain evidence of the actual call.
