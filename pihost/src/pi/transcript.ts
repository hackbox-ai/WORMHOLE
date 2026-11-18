import {getCurrentSystemPrompt, getCurrentTools, normalizeContext, type Context, type TranscriptContext} from '@earendil-works/pi-ai';

/** Keep observability and token estimates consistent with Pi's system-message transcript. */
export function contextView(context: Context | TranscriptContext): Context {
 const raw=context as Context;
 return {systemPrompt:raw.systemPrompt??getCurrentSystemPrompt(context.messages),tools:raw.tools??getCurrentTools(context.messages),messages:context.messages.filter(message=>message.role!=='system')};
}

/** Also supports standalone probes which start with an ordinary Context. */
export function providerContext(context: Context | TranscriptContext): TranscriptContext {
 return normalizeContext(context);
}
