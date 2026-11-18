# Task browser workspace

Entry: Task details → Task browser. There is no need to wait for the Worker to open; users can also open pages within the registered web target while the task is created, queued, or paused.

## Use

- Create environments on demand and name them freely. Browser status is isolated between environments; tabs within the environment share Cookie/localStorage, and sessionStorage follows the browser's tab semantics.
- Address bar, forward/back, refresh, click, keyboard, scroll, paste and Chinese input are all performed by server-side Chromium. Target HTML is not injected into the WORMHOLE page.
- Take over/hand over control of the current tab; select "Login/Switch Identity" when logging in or switching identities, and the Agent operation of this environment is waiting for user handover.
- "Leave it to Agent" saves the clues and descriptions of the current page, notifies the current arrangement, does not create new tasks, does not automatically resume suspended tasks, and does not automatically start queued tasks.

## Worker access

task_browser(action=list) reads the environment/tab directory; environment_id / tab_id selects an existing environment; new_tab creates a shared state tab; new_environment creates an isolated environment.

waiting_for_user should continue other independent checks and wait for handover without looping retries.

http_request(browser_environment=<id>) uses the specified environment's cookies and browser-observed Authorization in the current task. Do not guess the Token in localStorage; page memory, sessionStorage, and dynamic signatures can still be executed through the corresponding pages. HTTP legal Set-Cookie is synchronized back to the environment; status writeback of old requests is discarded when the browser authentication has changed.

Tool parameters do not require original cookies, results include environment identification and certification revision summary. Browser traffic retains task/environment identification and inherits task MITM, asset rules, and network channels.

## Life cycle and boundaries

- After the Worker is completed, page control is released and the environment is retained; cancellation of a single Worker does not destroy other environments.
- Pause and interrupt the Agent page that is executing the operation, hand over the idle page to the manual, and retain the environment authentication; manual browsing uses independent browser network access, and ordinary Worker packet sending is still blocked by the pause control.
- Environment is recycled after a task is stopped, completed, deleted, service shut down, or idle for 15 minutes. It is not shared across tasks, and the login status is not guaranteed to be retained after the service is restarted.
- There are a maximum of 3 environments globally, and a maximum of 8 tabs in each environment. A clear prompt will be returned if the limit is exceeded.
- Inherit runtime restrictions: block WebSocket, Service Worker, and do not accept downloads; SSO domain names need to be registered as task targets. This implementation does not claim to support all desktop browser features.

## Verify

    npm run typecheck
    WORMHOLE_CONFIG=<test-config> node --import tsx --test tests/browser-workspace.test.ts tests/task-web-targets.test.ts
    WORMHOLE_CONFIG=<test-config> WORMHOLE_NETWORK_INTEGRATION=1 node --import tsx --test tests/network-mode.test.ts

Add WORMHOLE_BROWSER_LIVE=1 to perform real worker/HTTP/fact writeback acceptance for two logged-in environments using the development machine configured model. All these tests use a standalone database schema.

Network integration tests include real FRP, network namespaces, login traffic, manual browsing after pause, and no direct fallback.

The machine on which the browser is running requires Chinese fonts. The development machine openEuler has been installed through dnf install -y wqy-microhei-fonts and checked with fc-list :lang=zh. Other distributions should install the Chinese font package from their distribution source.
