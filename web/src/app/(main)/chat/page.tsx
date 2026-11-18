"use client";
import { HelpButton } from "@/components/user-guide";

import * as React from "react";
import {StreamStatus} from "@/components/stream-status";
import Image from "next/image";
import { ConversationFiles } from "@/components/conversation-files";

import {
  ArrowUpIcon,
  Bot,
  ChevronDownIcon,
  ListChecksIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PaperclipIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  Square,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";

import { ApprovalExecutionFocus, useApprovalFocus, useApprovalHistory } from "@/components/approval-execution-focus";
import { MentionTextarea } from "@/components/mention-textarea";
import { SideQuestionButton, SideQuestionWorkspace } from "@/components/side-question-workspace";
import { TodoPopover } from "@/components/todo-popover";
import { Transcript } from "@/components/transcript";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { useSideQuestions } from "@/hooks/use-side-questions";
import { mergeActivities } from "@/lib/activity-merge";
import { api, sseUrl } from "@/lib/api";
import { MOCK } from "@/lib/mock/enabled";
import { shouldSubmitOnKey, useChatSendMode } from "@/lib/chat-send-mode";
import { isBtwCommand } from "@/lib/side-questions";
import type { Activity, Agent, ChatAttachment, Conversation, LLMProfile } from "@/lib/types";
import { cn } from "@/lib/utils";

// fmtBytes renders a human file size for attachment chips (mirrors transcript.tsx).
function fmtBytes(n: number): string {
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

// fmtTokens renders a compact token count (1234 → 1.2k, 2_000_000 → 2M).
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

// fmtDuration renders an elapsed milliseconds span compactly (90s → 1m30s).
function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

// HISTORY_PAGE is how many steps one history page loads: the latest page on open,
// then one more page each time the user scrolls to the top. Kept modest so a long
// thread stays snappy (only ~a page of rows is in the DOM until you scroll up).
const HISTORY_PAGE = 200;
const CONVERSATION_LIST_PAGE = 100;

const OTHER_AGENT_FILTER = "__other_agents__";

function conversationIsPinned(conversation: Conversation): boolean {
  return conversation.pinned ?? Boolean(conversation.pinned_at);
}

// LiveBadge is the small pulsing "Real time" chip reused from the task's main-agent
// console — shown while a turn is streaming.
function LiveBadge(){return <StreamStatus compact/>;}

// Composer is the shared bottom input (textarea grows to a cap, Enter sends,
// Shift+Enter newlines) — the same affordance across DraftChat and ChatView.
function Composer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  leftSlot,
  running,
  onStop,
  stopDisabled,
  attachments,
  onPickFiles,
  onRemoveAttachment,
  uploading,
  allowBtw,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  leftSlot?: React.ReactNode;
  running?: boolean;
  onStop?: () => void;
  stopDisabled?: boolean;
  // Method1 File upload:Passed onPickFiles The paper clip button is only shown + Attachment chip Preview。
  attachments?: ChatAttachment[];
  onPickFiles?: (files: File[]) => void;
  onRemoveAttachment?: (path: string) => void;
  uploading?: boolean;
  allowBtw?: boolean;
}) {
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const atts = attachments ?? [];
  // The sending key is determined by the system settings（localStorage），Default Enter Send。
  const sendMode = useChatSendMode();
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitOnKey(e, sendMode)) return;
    e.preventDefault();
    onSend();
  }
  return (
    <div className="studio-composer">
      {atts.length>0&&<div className="studio-composer-attachments">
        {atts.map(a=><div key={a.path} className="studio-attachment" title={a.name}>
          <PaperclipIcon className="size-3 shrink-0"/>
          <span className="studio-attachment-name">{a.name}</span><span className="studio-attachment-size">{fmtBytes(a.size)}</span>
          {onRemoveAttachment&&<button type="button" onClick={()=>onRemoveAttachment(a.path)} aria-label={"Remove attachment "+a.name} title="Remove attachment"><XIcon className="size-3"/></button>}
        </div>)}
      </div>}
      <div className="studio-composer-body">
        <MentionTextarea className="studio-message-input resize-none" rows={2}
          placeholder={placeholder} value={value} disabled={disabled&&!(running&&allowBtw)}
          onValueChange={onChange} onKeyDown={onKeyDown}/>
      </div>
      <div className="studio-composer-toolbar">
        <div className="studio-composer-tools">
          {onPickFiles&&<>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={e=>{
              const picked=Array.from(e.target.files??[]);e.target.value="";
              if(picked.length)onPickFiles(picked);
            }}/>
            <Button type="button" size="icon" variant="ghost" className="studio-attach-button"
              onClick={()=>fileInputRef.current?.click()} disabled={disabled||uploading} title="Upload file" aria-label="Upload file">
              {uploading?<Loader2Icon className="size-4 animate-spin"/>:<PaperclipIcon className="size-4"/>}
            </Button>
          </>}
          {leftSlot&&<div className="studio-composer-profile">{leftSlot}</div>}
        </div>
        <div className="studio-composer-actions">
          {running&&allowBtw&&isBtwCommand(value)&&<Button type="button" size="icon" onClick={onSend} aria-label="Send bypass problem" title="Send bypass problem"><ArrowUpIcon/></Button>}
          {running?<Button type="button" size="icon" variant="destructive" onClick={onStop} disabled={stopDisabled} title="Stop this run" aria-label="Stop this run"><Square className="size-3.5 fill-current"/></Button>:
            <Button type="button" size="icon" onClick={onSend} disabled={disabled||(!value.trim()&&atts.length===0)}
              title={"Send message ("+(sendMode==="ctrl-enter"?"Ctrl / ⌘ + Enter":"Enter")+"）"} aria-label="Send message"><ArrowUpIcon/></Button>}
        </div>
      </div>
    </div>
  );
}

// LLMProfileRow shows the active LLM config in the toolbar and lets the user
// switch it via a Popover. `selected` is the profile id or null for default.
function LLMProfileRow({
  profiles,
  selected,
  onChange,
  disabled,
  rightSlot,
}: {
  profiles: LLMProfile[];
  selected: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  rightSlot?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const activeDefault = profiles.find((p) => p.is_default);
  const current = selected != null ? profiles.find((p) => Number(p.id) === selected) : null;
  const label = current ? current.name : `Default${activeDefault ? `（${activeDefault.name}）` : ""}`;

  return (
    <div className="studio-model-row flex min-w-0 shrink-0 items-center gap-1">
      <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Select model"
            title={label}
            className="studio-model-picker flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs disabled:pointer-events-none disabled:opacity-40"
          >
            <span className="truncate">{label}</span>
            <ChevronDownIcon className="size-3 shrink-0" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <p className="text-muted-foreground px-2 py-1 text-[11px] font-medium">Select LLM configuration</p>
          {/* default option */}
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
            className={cn(
              "flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-accent",
              selected == null && "bg-accent",
            )}
          >
            <span className="text-sm">Default{activeDefault ? `（${activeDefault.name}）` : ""}</span>
            {activeDefault && (
              <span className="text-muted-foreground text-[11px]">
                {activeDefault.format} · {activeDefault.model}
              </span>
            )}
          </button>
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                onChange(Number(p.id));
                setOpen(false);
              }}
              className={cn(
                "flex w-full flex-col rounded px-2 py-1.5 text-left hover:bg-accent",
                selected === Number(p.id) && "bg-accent",
              )}
            >
              <span className="text-sm">{p.name}</span>
              <span className="text-muted-foreground text-[11px]">
                {p.format} · {p.model}
              </span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
      {rightSlot}
    </div>
  );
}

// DraftChat is the default right-pane view: a fresh chat (agent picker in the
// header, centered empty state, composer) with NO conversation created yet. The
// conversation is created lazily on the first send (ChatGPT-style), then the
// parent switches to the real ChatView.
function DraftChat({
  agents,
  agentKey,
  profiles,
  onStarted,
}: {
  agents: Agent[];
  agentKey: string;
  profiles: LLMProfile[];
  onStarted: (c: Conversation, pending?: { input?: string; attachments?: ChatAttachment[] }) => void;
}) {
  const [llmProfileId, setLlmProfileId] = React.useState<number | null>(null);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);

  const agent = agents.find((a) => a.key === agentKey);

  async function send() {
    const msg = input.trim();
    if (!msg || !agentKey || sending) return;
    setSending(true);
    try {
      const c = await api.createConversation(agentKey, "", llmProfileId);
      await api.sendConversationMessage(c.id, msg);
      onStarted(c);
    } catch (e) {
      toast.error("Sending failed:" + (e as Error).message);
      setSending(false);
    }
  }

  // Attachments need a conversation to own the uploads dir (sessions/conv-<id>/),
  // and a draft has none yet — so picking a file CREATES the conversation, uploads
  // into it, then hands off to ChatView carrying the typed text + attachments (the
  // user sends from there). Mirrors the task main-agent console's upload, adapted to
  // the ChatGPT-style lazy-create flow.
  async function pickFiles(files: File[]) {
    if (files.length === 0 || !agentKey || uploading || sending) return;
    setUploading(true);
    try {
      const c = await api.createConversation(agentKey, "", llmProfileId);
      const r = await api.chatUpload("session", `conv-${c.id}`, files);
      onStarted(c, { input, attachments: r.attachments });
    } catch (e) {
      toast.error("Upload failed:" + (e as Error).message);
      setUploading(false);
    }
  }

  return (
    <div className="studio-draft">
      {/* empty / landing state fills the panel */}
      <div className="studio-welcome flex flex-col items-center gap-3 px-4 text-center">
        <div className="studio-welcome-brand flex size-14 items-center justify-center">
          <Image src="/brand/mark.svg?v=2" className="wormhole-brand-mark" alt="WORMHOLE" width={48} height={48} unoptimized priority />
        </div>
        <div className="text-lg font-medium">
          {agentKey === "auto" ? "How can I help you?" : `and ${agent?.name ?? agentKey} Dialogue`}
        </div>
        {!agent && (
          <p role="alert" className="text-destructive text-xs">

            Loading Agent configuration; message can be sent after loading is complete.
          </p>
        )}
      </div>

      <div className="studio-composer-shell">
        <Composer
          value={input}
          onChange={setInput}
          onSend={send}
          disabled={sending || uploading || !agent}
          placeholder="Input message, @ reference record"
          onPickFiles={pickFiles}
          uploading={uploading}
          leftSlot={<LLMProfileRow
          profiles={profiles}
          selected={llmProfileId}
          onChange={setLlmProfileId}
          disabled={sending || uploading}
        />}
        />
      </div>
    </div>
  );
}

// ChatView is the right pane for one conversation — mirrors the task detail's
// main-agent console: header with agent + live badge + token/duration meta, a
// scroll-stick transcript (chat mode), and the composer.
function ChatView({
  conv,
  agents,
  profiles,
  initial,
  onTitleMaybeChanged,
  onConvUpdated,
}: {
  conv: Conversation;
  agents: Agent[];
  profiles: LLMProfile[];
  // pending text + already-uploaded attachments handed off from a draft that
  // created this conversation via the paperclip (consumed once, on mount).
  initial?: { input?: string; attachments?: ChatAttachment[] };
  onTitleMaybeChanged: () => void;
  onConvUpdated: () => void;
}) {
  const approvalFocus = useApprovalFocus({ conversationId: conv.id });
  const [messages, setMessages] = React.useState<Activity[]>([]);
  const [running, setRunning] = React.useState(false);
  const [reconnecting, setReconnecting] = React.useState(false);
  const [input, setInput] = React.useState(initial?.input ?? "");
  const [sending, setSending] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  // Method1 File upload:Uploaded attachment(fell to sessions/conv-<id>/uploads/),Send with next message。
  const [attachments, setAttachments] = React.useState<ChatAttachment[]>(initial?.attachments ?? []);
  const [uploading, setUploading] = React.useState(false);
  const cursorRef = React.useRef(0); // newest loaded id — incremental-tail anchor
  const earliestRef = React.useRef(0); // earliest loaded id — reverse-pagination anchor
  const hasMoreRef = React.useRef(false); // older history remains above the loaded window
  const loadingMoreRef = React.useRef(false); // guard: one scroll-up load at a time
  const [historyLoaded, setHistoryLoaded] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false); // drives the "load earlier" hint
  const agent = agents.find((a) => a.key === conv.agent_key);
  const currentProfileId = conv.llm_profile_id ?? null;
  const side = useSideQuestions(`/api/conversations/${conv.id}`);

  async function changeProfile(id: number | null) {
    try {
      await api.updateConversationProfile(conv.id, id);
      onConvUpdated();
    } catch (e) {
      toast.error("Switching LLM failed:" + (e as Error).message);
    }
  }

  // conversation-scoped detail fetcher for the reused Transcript renderer.
  const fetchDetail = React.useCallback((seq: number) => api.conversationMsgDetail(conv.id, seq), [conv.id]);

  // seq of the most-recent TodoWrite tool call (for the Todo popover); null if none.
  const latestTodoSeq = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const a = messages[i];
      if (a.kind === "tool_use" && a.tool === "TodoWrite") return a.seq;
    }
    return null;
  }, [messages]);

  // reset + load whenever the selected conversation changes. Load only the LATEST
  // page on open — a long thread's final answer sits at the very end, so the newest
  // page shows it immediately (issue #3: opening/refresh used to load the oldest
  // page, so the completed result was missing until another message advanced the
  // cursor). Older history streams in on scroll-up (loadEarlier below).
  React.useEffect(() => {
    cursorRef.current = 0;
    earliestRef.current = 0;
    hasMoreRef.current = false;
    setHasMore(false);
    setMessages([]);
    setHistoryLoaded(false);
    setRunning(false);
    let live = true;
    api
      .conversationHistory(conv.id, 0, HISTORY_PAGE)
      .then((r) => {
        if (!live) return;
        setMessages((current) => mergeActivities(r.items, current));
        cursorRef.current = Math.max(cursorRef.current, r.cursor);
        earliestRef.current = r.items.length ? r.items[0].seq : 0;
        hasMoreRef.current = r.hasMore;
        setHasMore(r.hasMore);
        setRunning((current) => current || r.running);
        setHistoryLoaded(true);
      })
      .catch(() => {
        // A source link can retry history through its locator; ordinary chats
        // retain the existing usable empty state on a transient failure.
        if (live) setHistoryLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [conv.id]);

  // A trigger or another tab may start a turn while this conversation is open.
  // A false list snapshot must not stop the tail before its final messages load.
  React.useEffect(() => {
    if (conv.running) setRunning(true);
  }, [conv.running]);

  React.useEffect(() => {
    if (!running || !historyLoaded) return;
    const accept = (frame: { items: Activity[]; cursor: number; running: boolean }) => {
      if (frame.items.length) setMessages((previous) => mergeActivities(previous, frame.items));
      cursorRef.current = Math.max(cursorRef.current, frame.cursor);
      if (!frame.running) {
        setRunning(false);
        onTitleMaybeChanged();
      }
    };
    if (MOCK) {
      let live = true;
      let timer: ReturnType<typeof setTimeout>;
      const poll = async () => {
        try {
          const frame = await api.conversationMessages(conv.id, cursorRef.current);
          if (!live) return;
          accept(frame);
          if (!frame.running) return;
        } catch { /* Retry transient reads. */ }
        if (live) timer = setTimeout(() => void poll(), 1000);
      };
      void poll();
      return () => { live = false; clearTimeout(timer); };
    }
    const source = new EventSource(sseUrl(
      "/api/conversations/" + conv.id + "/stream?after=" + cursorRef.current,
    ));
    source.onopen = () => setReconnecting(false);
    source.onerror = () => setReconnecting(true);
    source.onmessage = (event) => {
      const frame = JSON.parse(event.data) as Parameters<typeof accept>[0];
      if (!frame.running) source.close();
      accept(frame);
    };
    return () => { source.close(); setReconnecting(false); };
  }, [running, historyLoaded, conv.id, onTitleMaybeChanged]);

  const loadFocusPage = React.useCallback(
    (before: number) => api.conversationHistory(conv.id, before, HISTORY_PAGE),
    [conv.id],
  );
  const mergeFocusPage = React.useCallback((page: { items: Activity[]; hasMore: boolean }) => {
    setMessages((prev) => mergeActivities(page.items, prev));
    earliestRef.current = page.items[0]?.seq ?? earliestRef.current;
    hasMoreRef.current = page.hasMore;
    setHasMore(page.hasMore);
  }, []);
  const focusHistory = useApprovalHistory(
    approvalFocus.state?.source,
    historyLoaded,
    messages,
    loadFocusPage,
    mergeFocusPage,
  );

  // ---- transcript auto-scroll (open → bottom; stick to bottom unless scrolled up) ----
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const atBottomRef = React.useRef(true);
  const viewport = React.useCallback(
    () => (contentRef.current?.closest('[data-slot="scroll-area-viewport"]') as HTMLElement | null) ?? null,
    [],
  );
  // Scroll-up loads one older page and prepends it, preserving the visual position
  // so the view doesn't jump (record height/offset before, restore the delta after).
  const loadEarlier = React.useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    const vp = viewport();
    if (!vp) return;
    loadingMoreRef.current = true;
    const prevH = vp.scrollHeight;
    const prevTop = vp.scrollTop;
    try {
      const r = await api.conversationHistory(conv.id, earliestRef.current, HISTORY_PAGE);
      if (r.items.length) {
        setMessages((prev) => mergeActivities(r.items, prev));
        earliestRef.current = r.items[0].seq;
      }
      hasMoreRef.current = r.hasMore;
      setHasMore(r.hasMore);
      requestAnimationFrame(() => {
        const v = viewport();
        if (v) v.scrollTop = prevTop + (v.scrollHeight - prevH);
      });
    } catch {
      /* transient — a later scroll retries */
    } finally {
      loadingMoreRef.current = false;
    }
  }, [conv.id, viewport]);
  React.useEffect(() => {
    const vp = viewport();
    if (!vp) return;
    const onScroll = () => {
      if (approvalFocus.state && !focusHistory.ready) return;
      atBottomRef.current = vp.scrollTop + vp.clientHeight >= vp.scrollHeight - 60;
      if (vp.scrollTop <= 80) void loadEarlier(); // near top → pull an older page
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [viewport, loadEarlier, approvalFocus.state, focusHistory.ready]);
  // open/switch a conversation → jump to the latest (bottom)
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing conversations intentionally retriggers the scroll reset.
  React.useLayoutEffect(() => {
    const vp = viewport();
    if (vp) {
      vp.scrollTop = vp.scrollHeight;
      atBottomRef.current = true;
    }
  }, [conv.id, viewport]);
  // new activity → stick to bottom only if the user is already pinned there
  // biome-ignore lint/correctness/useExhaustiveDependencies: message and running changes intentionally retrigger bottom anchoring.
  React.useLayoutEffect(() => {
    if (approvalFocus.state || !atBottomRef.current) return;
    const vp = viewport();
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, [messages, running, viewport, approvalFocus.state]);

  // Per-conversation token total, live — same accounting as the main-agent
  // console: completed runs' `result` sum + the in-progress run's latest `usage`.
  const tokenTotal = React.useMemo(() => {
    let i = 0,
      o = 0,
      cr = 0;
    let li = 0,
      lo = 0,
      lcr = 0;
    let turns = 0; // agent Cycle rounds = Number of model calls (one each time kind='usage'）
    for (const a of messages) {
      if (a.kind === "result") {
        i += a.input_tokens ?? 0;
        o += a.output_tokens ?? 0;
        cr += a.cache_read_tokens ?? 0;
        li = lo = lcr = 0;
      } else if (a.kind === "usage") {
        turns += 1;
        li = a.input_tokens ?? 0;
        lo = a.output_tokens ?? 0;
        lcr = a.cache_read_tokens ?? 0;
      }
    }
    const I = i + li,
      O = o + lo,
      CR = cr + lcr;
    return { i: I, o: O, cr: CR, turns, any: I + O + CR > 0 };
  }, [messages]);

  // pickFiles uploads into this conversation's session dir (sessions/conv-<id>/
  // uploads/) and queues the returned metadata to send with the next message.
  async function pickFiles(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const r = await api.chatUpload("session", `conv-${conv.id}`, files);
      setAttachments((prev) => [...prev, ...r.attachments]);
    } catch (e) {
      toast.error("Upload failed:" + (e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const msg = input.trim();
    const atts = attachments;
    if (side.handleCommand(msg, () => setInput(""))) return;
    if ((!msg && atts.length === 0) || sending || running) return;
    setSending(true);
    setInput("");
    setAttachments([]);
    try {
      await api.sendConversationMessage(conv.id, msg, atts.length ? atts : undefined);
      // The live loop pulls the persisted human turn immediately. Sharing that
      // fetch avoids racing a separate post-send request against the poller.
      setRunning(true);
    } catch (e) {
      toast.error("Sending failed:" + (e as Error).message);
      setInput(msg); // restore so the user doesn't lose their text
      setAttachments(atts); // and their attachments
    } finally {
      setSending(false);
    }
  }

  // stop aborts the in-flight run for this conversation. running flips to false on
  // the next 1s poll once the backend unwinds the agent; the trigger queue is not
  // affected — the agent's next queued fire still starts.
  async function stop() {
    if (stopping) return;
    setStopping(true);
    try {
      await api.stopConversation(conv.id);
    } catch (e) {
      toast.error("Stop failed:" + (e as Error).message);
    } finally {
      setStopping(false);
    }
  }

  return (
    <SideQuestionWorkspace side={side} label={agent?.name ?? conv.agent_key} composerLayout="inline">
      <div className="studio-chat-header flex min-w-0 items-center gap-2 px-4 py-3">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{conv.title || "New conversation"}</span>
        {running && (reconnecting ? <span role="status" className="text-xs text-muted-foreground">Reconnecting...</span> : <LiveBadge />)}
        <SideQuestionButton side={side} />
        <ConversationFiles key={conv.id} id={conv.id} />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Session details" title="Session details">
              <MoreHorizontalIcon />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 space-y-3 text-sm">
            <div className="font-medium">Session details</div>
            <div className="text-muted-foreground text-xs">
              Agent：{agent?.name ?? conv.agent_key} · #{conv.id}
            </div>
            {agent?.description && <p className="text-muted-foreground text-xs">{agent.description}</p>}
            <dl className="grid grid-cols-2 gap-2 text-xs tabular-nums">
              <dt className="text-muted-foreground">Model call</dt>
              <dd>{tokenTotal.turns}  Wheel</dd>
              <dt className="text-muted-foreground">Enter Token</dt>
              <dd>{fmtTokens(tokenTotal.i)}</dd>
              <dt className="text-muted-foreground">Cache Token</dt>
              <dd>{fmtTokens(tokenTotal.cr)}</dd>
              <dt className="text-muted-foreground">Output Token</dt>
              <dd>{fmtTokens(tokenTotal.o)}</dd>
            </dl>
          </PopoverContent>
        </Popover>
      </div>

      <ApprovalExecutionFocus focus={approvalFocus} history={focusHistory} />

      {/* messages */}
      <ScrollArea
        type="auto"
        className="studio-chat-scroll min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!"
      >
        <div className="studio-message-column min-w-0" ref={contentRef}>
          {messages.length === 0 && !running ? (
            <div className="text-muted-foreground py-10 text-center text-sm">

              Start with &quot;{agent?.name ?? conv.agent_key}&quot;Dialogue
            </div>
          ) : (
            <>
              {hasMore && (
                <div className="text-muted-foreground/70 pb-2 text-center text-[11px]">Scroll up to load older messages…</div>
              )}
              <Transcript
                activity={messages}
                live={running}
                chat
                fetchDetail={fetchDetail}
                focusedSeq={focusHistory.ready ? approvalFocus.state?.source?.seq : undefined}
              />
            </>
          )}
        </div>
      </ScrollArea>

      <div className="studio-composer-shell">
        <Composer
          value={input}
          onChange={setInput}
          onSend={send}
          disabled={running || sending}
          allowBtw
          placeholder={running ? "Enter /btw temporary question" : "Input message, @ reference record"}
          running={running}
          onStop={stop}
          stopDisabled={stopping}
          attachments={attachments}
          onPickFiles={pickFiles}
          onRemoveAttachment={(path) => setAttachments((p) => p.filter((x) => x.path !== path))}
          uploading={uploading}
          leftSlot={<LLMProfileRow
          profiles={profiles}
          selected={currentProfileId}
          onChange={changeProfile}
          disabled={running || sending}
          rightSlot={<TodoPopover seq={latestTodoSeq} fetchDetail={fetchDetail} />}
        />}
        />
      </div>
    </SideQuestionWorkspace>
  );
}

// ConversationItem is one row in the left rail: title, agent subtitle, inline
// rename, pin marker, and a compact action menu. Rows nested under an agent
// group drop the agent subtitle (showAgent=false) — the header already says it.
const ConversationItem = React.memo(function ConversationItem({
  conv,
  agent,
  showAgent = false,
  active,
  renaming,
  renameText,
  onSelect,
  onStartRename,
  onRenameText,
  onCommitRename,
  onCancelRename,
  onTogglePinned,
  onDelete,
  selectionMode,
  selectedForDelete,
  onSelectedForDeleteChange,
}: {
  conv: Conversation;
  agent?: Agent;
  showAgent?: boolean;
  active: boolean;
  renaming: boolean;
  renameText: string;
  onSelect: (id: number) => void;
  onStartRename: (conversation: Conversation) => void;
  onRenameText: (v: string) => void;
  onCommitRename: (id: number, title: string) => void;
  onCancelRename: () => void;
  onTogglePinned: (conversation: Conversation) => void;
  onDelete: (id: number) => void;
  selectionMode: boolean;
  selectedForDelete: boolean;
  onSelectedForDeleteChange: (id: number, checked: boolean) => void;
}) {
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const renameInputRef = React.useRef<HTMLInputElement>(null);
  const cancelRenameRef = React.useRef(false);
  const pinned = conversationIsPinned(conv);

  React.useEffect(() => {
    if (!renaming) return;
    cancelRenameRef.current = false;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  return (
    <div
      data-conversation-id={conv.id}
      data-active={active}
      data-agent-key={conv.agent_key}
      className="studio-history-item group flex min-w-0 items-center gap-1 rounded-2xl pr-1"
    >
      {selectionMode && (
        <Checkbox
          checked={selectedForDelete}
          onCheckedChange={(checked) => onSelectedForDeleteChange(conv.id, checked === true)}
          aria-label={`Select conversation "${conv.title || "New conversation"}」`}
          className="ml-1 shrink-0"
        />
      )}
      {renaming ? (
        <input
          ref={renameInputRef}
          value={renameText}
          onChange={(e) => onRenameText(e.target.value)}
          onBlur={() => {
            if (!cancelRenameRef.current) onCommitRename(conv.id, renameText);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(conv.id, renameText);
            if (e.key === "Escape") {
              e.preventDefault();
              cancelRenameRef.current = true;
              onCancelRename();
            }
          }}
          className="border-input bg-background min-w-0 flex-1 rounded-xl border px-2 py-1 text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => onSelect(conv.id)}
          onDoubleClick={() => onStartRename(conv)}
          title="Double-click to rename"
          aria-current={active ? "page" : undefined}
          className="min-w-0 flex-1 rounded-xl px-2 py-1.5 text-left"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {pinned && <PinIcon className="text-primary size-3 shrink-0" aria-label="Pinned" />}
            <div className="truncate text-sm">{conv.title || "New conversation"}</div>
            {conv.running ? (
              <Badge variant="secondary" className="shrink-0 gap-1" title="Agent is running">
                <Spinner className="size-3" aria-hidden="true" />

                Running
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1 truncate text-xs" data-conversation-preview>
            {conv.last_message?.trim() || "No news yet"}
          </p>
          <div className="text-muted-foreground mt-1 flex min-w-0 items-center gap-1 text-[11px]">
            {showAgent && (
              <>
                <Bot className="size-3 shrink-0" />
                <span className="min-w-0 truncate">{agent?.name ?? conv.agent_key}</span>
                <span className="shrink-0">·</span>
              </>
            )}
            <span className="shrink-0">
              {new Date(conv.updated_at).toLocaleDateString("en-US", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>
        </button>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground shrink-0 rounded-full"
            aria-label={`Manage Dialog "${conv.title || "New conversation"}」`}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            <DropdownMenuItem onSelect={() => onStartRename(conv)}>
              <PencilIcon />

              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onTogglePinned(conv)}>
              {pinned ? <PinOffIcon /> : <PinIcon />}
              {pinned ? "Cancel pin" : "Pin to top"}
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <Trash2Icon />

              Delete
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation &quot;{conv.title || "New conversation"}」？</AlertDialogTitle>
            <AlertDialogDescription>This operation cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => onDelete(conv.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

export default function ChatPage() {
  const [agents, setAgents] = React.useState<Agent[]>([]);
  const [profiles, setProfiles] = React.useState<LLMProfile[]>([]);
  const [convs, setConvs] = React.useState<Conversation[]>([]);
  const [agentFilter, setAgentFilter] = React.useState("auto");
  const [draftAgentKey, setDraftAgentKey] = React.useState("auto");
  const [draftVersion, setDraftVersion] = React.useState(0);
  const [agentDialogOpen, setAgentDialogOpen] = React.useState(false);
  const [specifiedAgentKey, setSpecifiedAgentKey] = React.useState("pentest");
  const restoredView = React.useRef(false);
  const [selectedId, setSelectedId] = React.useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [sourceRequested, setSourceRequested] = React.useState(false);
  const [convsLoaded, setConvsLoaded] = React.useState(false);
  const selectConversation = React.useCallback(
    (id: number | null) => {
      if (id !== selectedId) {
        const url = new URL(window.location.href);
        url.searchParams.delete("approval");
        setSourceRequested(false);
        window.history.replaceState(null, "", url);
      }
      setSelectedId(id);
    },
    [selectedId],
  );

  const [renamingId, setRenamingId] = React.useState<number | null>(null);
  const [renameText, setRenameText] = React.useState("");
  const [selectedConversationIds, setSelectedConversationIds] = React.useState<Set<number>>(() => new Set());
  // selectionMode gates the multi-select UI: off by default (clean list, no
  // checkboxes); the header "Multiple selection" button turns it on, "Complete" turns it off and
  // clears the selection.
  const [selectionMode, setSelectionMode] = React.useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = React.useState(false);
  const [bulkDeleting, setBulkDeleting] = React.useState(false);
  const [visibleConversationCount, setVisibleConversationCount] = React.useState(CONVERSATION_LIST_PAGE);
  // Pending text + uploaded attachments handed off from a draft that created a
  // conversation via the paperclip, keyed by the new conversation id (consumed once
  // by ChatView on mount; ids never repeat, so leftover entries are harmless).
  const [pendingByConv, setPendingByConv] = React.useState<
    Record<number, { input?: string; attachments?: ChatAttachment[] }>
  >({});

  const conversationListSeq = React.useRef(0);
  const reloadConvs = React.useCallback(async () => {
    const seq = ++conversationListSeq.current;
    try {
      const items = await api.conversations();
      if (seq === conversationListSeq.current) {
        setConvs(items);
        setConvsLoaded(true);
      }
    } catch {
      // Preserve the selected transcript and list on a transient poll failure.
    }
  }, []);
  React.useEffect(() => {
    api
      .agents()
      .then(setAgents)
      .catch(() => {
        /* Agent metadata is optional for rendering an existing conversation. */
      });
    api
      .llmProfiles()
      .then(setProfiles)
      .catch(() => {
        /* The conversation remains usable without profile labels. */
      });
  }, []);

  // One list poll supplies runtime state for all sidebar rows, including the
  // unselected ones. Await completion so slow requests do not overlap.
  React.useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      await reloadConvs();
      if (!disposed) timer = setTimeout(() => void poll(), 2000);
    }
    void poll();
    return () => {
      disposed = true;
      conversationListSeq.current++;
      clearTimeout(timer);
    };
  }, [reloadConvs]);

  React.useEffect(() => {
    setSelectedConversationIds((current) => {
      if (current.size === 0) return current;
      const live = new Set(convs.map((conversation) => conversation.id));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [convs]);

  // Restore the open conversation from the URL (?c=<id>) on mount, so a refresh
  // returns to the same thread instead of the empty draft view. Runs after
  // hydration (not a lazy useState init) to avoid a server/client mismatch.
  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setSourceRequested(params.has("approval"));
    const c = params.get("c");
    const id = c ? Number(c) : NaN;
    if (Number.isFinite(id)) setSelectedId(id);
  }, []);
  // Mirror the current selection into the URL (replaceState → no history spam). A
  // selectedId with no matching conversation (e.g. a stale ?c=, or a just-created
  // one before reloadConvs lands) simply renders the draft view — harmless — so we
  // deliberately do NOT auto-clear it here (that raced new-conversation creation).
  React.useEffect(() => {
    const url = new URL(window.location.href);
    if (selectedId != null) url.searchParams.set("c", String(selectedId));
    else url.searchParams.delete("c");
    window.history.replaceState(null, "", url);
  }, [selectedId]);

  const selected = React.useMemo(() => convs.find((c) => c.id === selectedId) ?? null, [convs, selectedId]);
  const agentByKey = React.useMemo(() => new Map(agents.map((agent) => [agent.key, agent])), [agents]);
  const filteredConversations = React.useMemo(
    () =>
      convs.filter((conversation) =>
        agentFilter === OTHER_AGENT_FILTER ? conversation.agent_key !== "auto" : conversation.agent_key === agentFilter,
      ),
    [convs, agentFilter],
  );
  const visibleConversations = React.useMemo(
    () => filteredConversations.slice(0, visibleConversationCount),
    [filteredConversations, visibleConversationCount],
  );
  // Keep server ordering (pinned first, then latest activity), with no role groups.
  React.useEffect(() => {
    if (!convsLoaded || !selected || restoredView.current) return;
    restoredView.current = true;
    if (selected.agent_key !== "auto") setAgentFilter(selected.agent_key);
  }, [convsLoaded, selected]);
  // conversation agents: custom agents + conversational built-ins (role=assistant,
  // e.g. Auto / Penetration Testing). The orchestration built-ins (goals/planner/mainagent/worker)
  // are task-specific and stay hidden from the chat page.
  const chatAgents = React.useMemo(() => agents.filter((a) => !a.builtin || a.role === "assistant"), [agents]);
  const agentFilterOptions = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const conversation of convs) {
      counts.set(conversation.agent_key, (counts.get(conversation.agent_key) ?? 0) + 1);
    }
    // Include historical sources even if their Agent has since been disabled or deleted.
    const keys = new Set([...chatAgents.map((agent) => agent.key), ...counts.keys()]);
    if (agentFilter !== "auto" && agentFilter !== OTHER_AGENT_FILTER) keys.add(agentFilter);
    return [...keys]
      .filter((key) => key !== "auto")
      .map((key) => ({ key, name: agentByKey.get(key)?.name || key, count: counts.get(key) ?? 0 }))
      .sort((a, b) => a.name.localeCompare(b.name, "en-US"));
  }, [convs, chatAgents, agentByKey, agentFilter]);
  const conversationCountLabel = `Total ${filteredConversations.length} conversations`;

  function changeAgentFilter(key: string) {
    setAgentFilter(key);
    setSelectionMode(false);
    setVisibleConversationCount(CONVERSATION_LIST_PAGE);
    setSelectedConversationIds(new Set());
    setBulkDeleteOpen(false);
    setRenamingId(null);
    if (selected && (key === OTHER_AGENT_FILTER ? selected.agent_key === "auto" : selected.agent_key !== key))
      selectConversation(null);
  }

  function startDraft(key = "auto") {
    restoredView.current = true;
    changeAgentFilter(key);
    selectConversation(null);
    setDraftAgentKey(key);
    setDraftVersion((version) => version + 1);
  }

  const selectedConversationCount = selectedConversationIds.size;
  const allConversationsSelected =
    filteredConversations.length > 0 && selectedConversationCount === filteredConversations.length;
  const someConversationsSelected = selectedConversationCount > 0 && !allConversationsSelected;
  let conversationHeaderChecked: boolean | "indeterminate" = false;
  if (allConversationsSelected) conversationHeaderChecked = true;
  else if (someConversationsSelected) conversationHeaderChecked = "indeterminate";

  const toggleConversationSelected = React.useCallback((id: number, checked: boolean) => {
    setSelectedConversationIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  function toggleAllConversations(checked: boolean) {
    setSelectedConversationIds(
      checked ? new Set(filteredConversations.map((conversation) => conversation.id)) : new Set(),
    );
  }

  function exitSelectionMode() {
    setSelectionMode(false);
    setSelectedConversationIds(new Set());
  }

  const del = React.useCallback(
    async (id: number) => {
      try {
        await api.deleteConversation(id);
        setSelectedId((current) => (current === id ? null : current));
        setSelectedConversationIds((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        void reloadConvs();
      } catch (e) {
        toast.error("Delete failed:" + (e as Error).message);
      }
    },
    [reloadConvs],
  );

  async function deleteSelectedConversations() {
    const ids = [...selectedConversationIds];
    if (ids.length === 0 || bulkDeleting) return;
    setBulkDeleting(true);
    const deleted = new Set<number>();
    const failed: { id: number; error: string }[] = [];
    try {
      for (let offset = 0; offset < ids.length; offset += 100) {
        const result = await api.deleteConversations(ids.slice(offset, offset + 100));
        for (const item of result.items) {
          if (item.ok) deleted.add(item.id);
          else failed.push({ id: item.id, error: item.error ?? "Conversation does not exist" });
        }
      }
      if (deleted.has(selectedId ?? -1)) selectConversation(null);
      setSelectedConversationIds((current) => {
        const next = new Set(current);
        for (const id of deleted) next.delete(id);
        return next;
      });
      if (deleted.size > 0) toast.success(`Deleted ${deleted.size} conversations`);
      if (failed.length > 0) {
        const details = failed
          .slice(0, 3)
          .map((item) => `#${item.id}（${item.error}）`)
          .join("；");
        toast.error(`${failed.length} Conversation deletion failed:${details}${failed.length > 3 ? " etc." : ""}`);
      }
      setBulkDeleteOpen(false);
      // Fully successful → return to the clean list; keep selection mode on if
      // some failed so the user can retry the remaining ones.
      if (failed.length === 0) setSelectionMode(false);
      void reloadConvs();
    } catch (error) {
      toast.error(`Batch deletion failed:${(error as Error).message}`);
      void reloadConvs();
    } finally {
      setBulkDeleting(false);
    }
  }

  const togglePinned = React.useCallback(
    async (conversation: Conversation) => {
      const pinned = conversationIsPinned(conversation);
      try {
        await api.pinConversation(conversation.id, !pinned);
        void reloadConvs();
      } catch (e) {
        toast.error(`${pinned ? "Cancel pin" : "Pin to top"}Failure:${(e as Error).message}`);
      }
    },
    [reloadConvs],
  );

  const startRename = React.useCallback((c: Conversation) => {
    setRenamingId(c.id);
    setRenameText(c.title || "");
  }, []);
  const commitRename = React.useCallback(
    async (id: number, value: string) => {
      const title = value.trim();
      setRenamingId(null);
      if (!title) return;
      try {
        await api.renameConversation(id, title);
        void reloadConvs();
      } catch (e) {
        toast.error("Rename failed:" + (e as Error).message);
      }
    },
    [reloadConvs],
  );
  const cancelRename = React.useCallback(() => setRenamingId(null), []);

  return (
    <div
      data-content-padding="false"
      className="workspace-chat studio-chat flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[15rem_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
        {/* left: conversation list */}
        <div className="workspace-chat-list studio-chat-history flex min-h-0 flex-col overflow-hidden">
          <div className="flex flex-col gap-2 border-b p-2">
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                className="studio-new-chat min-w-0 flex-1"
                onClick={() => startDraft()}
              >
                <PlusIcon />  New conversation
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Dialog Options" disabled={bulkDeleting}>
                    <MoreHorizontalIcon />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuItem onSelect={() => setAgentDialogOpen(true)}>
                      <Bot />  Specify Agent
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => changeAgentFilter(OTHER_AGENT_FILTER)}>

                      Other Agent sessions
                    </DropdownMenuItem>
                    {agentFilter !== "auto" && (
                      <DropdownMenuItem onSelect={() => startDraft()}>Return to Auto dialog</DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            {agentFilter !== "auto" && (
              <div className="space-y-2 rounded-md bg-muted/30 p-2">
                <div className="flex items-center justify-between text-xs">
                  <span>Other Agent Sessions</span>
                  <Button size="sm" variant="ghost" onClick={() => startDraft()}>

                    Return to Auto
                  </Button>
                </div>
                <Select value={agentFilter} onValueChange={changeAgentFilter} disabled={bulkDeleting}>
                  <SelectTrigger size="sm" className="w-full" aria-label="Filter other Agent sessions">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={OTHER_AGENT_FILTER}>All other Agents</SelectItem>
                      {agentFilterOptions.map((agent) => (
                        <SelectItem key={agent.key} value={agent.key}>
                          {agent.name}（{agent.count}）
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}
            {convs.length > 0 &&
              (selectionMode ? (
                <div className="flex items-center gap-2 px-1">
                  <Checkbox
                    checked={conversationHeaderChecked}
                    onCheckedChange={(checked) => toggleAllConversations(checked === true)}
                    aria-label="Select all conversations currently filtered"
                    disabled={filteredConversations.length === 0 || bulkDeleting}
                  />
                  <span className="text-muted-foreground min-w-0 flex-1 text-xs tabular-nums">
                    {selectedConversationCount > 0 ? `Selected ${selectedConversationCount} indivual` : conversationCountLabel}
                  </span>
                  {selectedConversationCount > 0 && (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={bulkDeleting}
                      onClick={() => setBulkDeleteOpen(true)}
                    >
                      <Trash2Icon data-icon="inline-start" />

                      Delete
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={exitSelectionMode}>

                    Complete
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 px-1">
                  <span className="text-muted-foreground min-w-0 flex-1 text-xs tabular-nums">
                    {conversationCountLabel}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setSelectionMode(true)}
                    disabled={filteredConversations.length === 0}
                  >
                    <ListChecksIcon data-icon="inline-start" />

                    Multiple selection
                  </Button>
                </div>
              ))}
          </div>
          <button
            type="button"
            className="studio-history-toggle md:hidden"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
          >

            Recent conversations <ChevronDownIcon className={cn("size-3.5 transition-transform", historyOpen && "rotate-180")} />
          </button>
          <ScrollArea
            key={agentFilter}
            type="auto"
            className={cn(
              "studio-history-scroll min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!",
              !historyOpen && "hidden md:block",
            )}
          >
            <div className="studio-history-entries flex min-w-0 flex-col gap-1.5 p-2.5">
              {filteredConversations.length === 0 && (
                <p className="text-muted-foreground px-2 py-6 text-center text-xs">
                  {convsLoaded ? "There is no conversation yet. Start a new conversation." : "Loading conversation..."}
                </p>
              )}
              {visibleConversations.map((c) => (
                <ConversationItem
                  key={c.id}
                  conv={c}
                  agent={agentByKey.get(c.agent_key)}
                  showAgent={agentFilter !== "auto"}
                  active={selectedId === c.id}
                  renaming={renamingId === c.id}
                  renameText={renamingId === c.id ? renameText : ""}
                  onSelect={(conversationId) => {
                    selectConversation(conversationId);
                    setHistoryOpen(false);
                  }}
                  onStartRename={startRename}
                  onRenameText={setRenameText}
                  onCommitRename={commitRename}
                  onCancelRename={cancelRename}
                  onTogglePinned={togglePinned}
                  onDelete={del}
                  selectionMode={selectionMode}
                  selectedForDelete={selectedConversationIds.has(c.id)}
                  onSelectedForDeleteChange={toggleConversationSelected}
                />
              ))}
              {visibleConversationCount < filteredConversations.length && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1 w-full"
                  onClick={() => setVisibleConversationCount((count) => count + CONVERSATION_LIST_PAGE)}
                >

                  Load more
                </Button>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* right: chat view */}
        <div className="workspace-chat-main studio-chat-canvas flex min-h-0 min-w-0 flex-col overflow-hidden">
          {selected ? (
            <ChatView
              key={selected.id}
              conv={selected}
              agents={agents}
              profiles={profiles}
              initial={pendingByConv[selected.id]}
              onTitleMaybeChanged={reloadConvs}
              onConvUpdated={reloadConvs}
            />
          ) : sourceRequested ? (
            <div role="status" className="p-6 text-sm text-muted-foreground">
              {convsLoaded ? "Conversation has been deleted" : "Loading corresponding dialogue..."}
            </div>
          ) : (
            <DraftChat
              key={draftVersion}
              agentKey={draftAgentKey}
              agents={chatAgents}
              profiles={profiles}
              onStarted={(c, pending) => {
                if (agentFilter !== c.agent_key) changeAgentFilter(c.agent_key);
                // Insert the new conversation immediately so `selected` resolves to
                // it on this render (switching to ChatView right away, before the
                // async reloadConvs lands); reloadConvs then reconciles titles etc.
                if (pending) setPendingByConv((p) => ({ ...p, [c.id]: pending }));
                setConvs((prev) => {
                  if (prev.some((item) => item.id === c.id)) return prev;
                  const firstUnpinned = prev.findIndex((item) => !conversationIsPinned(item));
                  const insertAt = firstUnpinned < 0 ? prev.length : firstUnpinned;
                  return [...prev.slice(0, insertAt), c, ...prev.slice(insertAt)];
                });
                setSelectedId(c.id);
                void reloadConvs();
              }}
            />
          )}
        </div>
      </div>
      <Dialog open={agentDialogOpen} onOpenChange={setAgentDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Specify Agent</DialogTitle>
            <DialogDescription className="sr-only">Operation and parameter description</DialogDescription><HelpButton topic="tasks" />
          </DialogHeader>
          <Select value={specifiedAgentKey} onValueChange={setSpecifiedAgentKey}>
            <SelectTrigger aria-label="Select Agent to run">
              <SelectValue placeholder="Select Agent" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {chatAgents.map((agent) => (
                  <SelectItem key={agent.key} value={agent.key}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAgentDialogOpen(false)}>

              Cancel
            </Button>
            <Button
              disabled={!chatAgents.some((agent) => agent.key === specifiedAgentKey)}
              onClick={() => {
                startDraft(specifiedAgentKey);
                setAgentDialogOpen(false);
              }}
            >

              Start conversation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete selected {selectedConversationCount}  conversations?</AlertDialogTitle>
            <AlertDialogDescription>The conversation messages and execution records will be deleted together, and this operation cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={bulkDeleting || selectedConversationCount === 0}
              onClick={(event) => {
                event.preventDefault();
                void deleteSelectedConversations();
              }}
            >
              {bulkDeleting && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {bulkDeleting ? "Deleting" : "Confirm deletion"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
