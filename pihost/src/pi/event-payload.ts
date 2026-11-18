/** Streaming updates contain two copies of the growing assistant snapshot.
 * Store append-only deltas instead. message_start/message_end remain complete,
 * and Pi's checkpoint remains the source for resuming the model context.
 * Versioned payloads let replay clients distinguish deltas from legacy snapshots.
 */
export function durableSessionEvent(event: Record<string, any>): Record<string, unknown> {
  if (event.type !== 'message_update') return JSON.parse(JSON.stringify(event));
  const {partial: _partial, ...delta} = event.assistantMessageEvent ?? {};
  const {message: _message, assistantMessageEvent: _update, ...metadata} = event;
  return JSON.parse(JSON.stringify({...metadata, storage_version: 2, assistantMessageEvent: delta}));
}

/** Wire replay uses the same delta contract as new writes. Original historical
 * bytes remain available in logical exports and immutable cold archives.
 */
export function replaySessionPayload(eventType:string,payload:any):unknown{
  if(eventType!=='message_update'||payload?.type!=='message_update')return payload;
  const update=payload.assistantMessageEvent;
  if(update!=null&&(typeof update!=='object'||Array.isArray(update)))return payload;
  return durableSessionEvent(payload);
}
