# Task Browser

## Open the browser environment

Select the task browser in the task details, create or select a browser environment, enter the target address and browse. Users can log in manually, and the Agent can also operate the corresponding environment according to task needs.

The browser environment is named according to its purpose, such as ordinary user, administrator, tenant one or non-login environment; it is not limited to two fixed accounts.

## Multiple identity test

Use independent environments for different identities to avoid mixed use of cookies caused by repeated logins in the same environment. Label each environment with its site, identity, and purpose, and tell the Agent which environment should be used.

Check that the page is in the expected identity after logging in. The reuse of Cookie or Session does not mean that all tools automatically have the same request headers, browser storage and network conditions, and should be checked against the actual request.

## Manual takeover and sharing

When Agent requires login or manual operation, it can enter the browser to take over. When the task is suspended, the Agent stops operating, but the user can still continue to log in and browse. After completion, it is up to the user to resume the task.

By default, identity reuse within the same task is used as the boundary. Cross-task sharing should explicitly select and verify sites, applications, and accounts to avoid mixing credentials from different customers or tenants.

## Network and Traffic

Browsers in springboard tasks need to use task binding channels. Whether traffic enters the recording link depends on the capture switch, actual browser configuration and traffic page results. The appearance of the browser screen does not mean that all requests have been entered into the database.
