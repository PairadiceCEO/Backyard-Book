// Casino chat UI (0.17.0): a Chat button with an unread badge, and a drawer that slides over the page (it never
// pushes the table down). The drawer: room name, the last 30 messages of the past 24 hours (oldest at the top), sender
// and Central time, my messages styled apart, auto-scroll to the newest only when I'm already at the bottom, a text box
// with a 200-character counter, Send (also on Enter). Plain text only: React prints it as text, links aren't clickable.
// The admin sees a Delete on each message, with a confirm.
//
// Hooks: no effect sets state from its own result; the scroll effect only reads/writes the list's scrollTop; the
// Escape key listener and the body scroll lock are removed when the drawer closes or the page goes away.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { adminAction } from '../../lib/api.js';
import { formatCentralShortClock } from '../../lib/format.js';
import { friendlyError } from '../StatusViews.jsx';
import { CHAT_MAX_CHARS, CHAT_REMOVED_TEXT, chatLength, chatRoomTitle, chatTextProblem, cleanChatText } from '../../../shared/casino/chat.js';

const AT_BOTTOM_PX = 32;

export function ChatButton({ chat, compact = false }) {
  const n = chat.unread;
  const label = `Chat${n ? `, ${n} unread` : ''}`;
  return (
    <button type="button" className={compact ? 'btn chat-btn compact' : 'btn chat-btn'} onClick={chat.toggle} aria-label={label} aria-expanded={chat.open}>
      <span aria-hidden="true" className="chat-icon">
        💬
      </span>
      {compact ? null : <span className="chat-btn-text">Chat</span>}
      {n ? (
        <span className="chat-badge" aria-hidden="true">
          {n > 99 ? '99+' : n}
        </span>
      ) : null}
    </button>
  );
}

function Message({ message, mine, isAdmin, room }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await adminAction('chatDelete', { game: room, messageId: message.id });
      setConfirming(false);
    } catch (err) {
      setError(friendlyError(err.message));
    } finally {
      setBusy(false);
    }
  }
  return (
    <li className={['chat-msg', mine ? 'mine' : '', message.deleted ? 'removed' : ''].filter(Boolean).join(' ')}>
      <div className="chat-msg-head">
        <span className="chat-msg-name">{mine ? 'You' : message.name}</span>
        <span className="chat-msg-time">{message.createdAtMs ? formatCentralShortClock(message.createdAtMs) : ''}</span>
      </div>
      <p className="chat-msg-text">{message.deleted ? CHAT_REMOVED_TEXT : message.text}</p>
      {isAdmin && !message.deleted ? (
        confirming ? (
          <div className="chat-confirm">
            <span className="small">Delete this message?</span>
            <button type="button" className="btn btn-danger small" onClick={remove} disabled={busy}>
              {busy ? 'Deleting…' : 'Yes, delete'}
            </button>
            <button type="button" className="btn small" onClick={() => setConfirming(false)} disabled={busy}>
              No
            </button>
          </div>
        ) : (
          <button type="button" className="chat-delete" onClick={() => setConfirming(true)} aria-label={`Delete ${message.name}'s message`}>
            Delete
          </button>
        )
      ) : null}
      {error ? <p className="error-text small">{error}</p> : null}
    </li>
  );
}

export function ChatDrawer({ chat }) {
  const { authUser, isAdmin } = useAuth();
  const myUid = authUser?.uid ?? null;
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(null); // { text, requestId }: a failed send is retried with the same id, so it posts once
  const listRef = useRef(null);
  const atBottom = useRef(true);
  const inputRef = useRef(null);
  const { open, close, messages, room } = chat;

  // Escape closes; the page behind doesn't scroll. Both undone on close/unmount.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    atBottom.current = true;
    inputRef.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
    };
  }, [open, close]);

  // New messages: follow them only if I was already at the bottom.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !atBottom.current) return;
    list.scrollTop = list.scrollHeight;
  }, [messages, open]);

  if (!open) return null;

  const cleaned = cleanChatText(text);
  const length = chatLength(text);
  const problem = chatTextProblem(cleaned);
  const tooLong = length > CHAT_MAX_CHARS;

  async function submit(e) {
    e.preventDefault();
    if (sending || problem) {
      if (problem && text) setError(problem);
      return;
    }
    const requestId = pending.current?.text === cleaned ? pending.current.requestId : chat.newRequestId();
    pending.current = { text: cleaned, requestId };
    setSending(true);
    setError('');
    try {
      await chat.send(cleaned, requestId);
      pending.current = null;
      setText('');
      atBottom.current = true;
    } catch (err) {
      setError(err.code === 'SLOW_DOWN' ? 'Slow down a little' : friendlyError(err.message));
    } finally {
      setSending(false);
    }
  }

  return createPortal(
    <>
      <div className="chat-backdrop" role="presentation" onClick={close} />
      <section className="chat-drawer" role="dialog" aria-modal="true" aria-label={chatRoomTitle(room)}>
        <header className="chat-head">
          <h3>{chatRoomTitle(room)}</h3>
          <button type="button" className="icon-button" aria-label="Close chat" onClick={close}>
            ×
          </button>
        </header>
        <ol
          className="chat-list"
          ref={listRef}
          aria-live="polite"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_PX;
          }}
        >
          {chat.loading ? <li className="muted small chat-empty">Loading…</li> : null}
          {!chat.loading && chat.error ? <li className="error-text small chat-empty">{chat.error}</li> : null}
          {!chat.loading && !chat.error && messages.length === 0 ? <li className="muted small chat-empty">No messages in the last 24 hours. Say hi!</li> : null}
          {messages.map((m) => (
            <Message key={m.id} message={m} mine={m.uid === myUid} isAdmin={isAdmin} room={room} />
          ))}
        </ol>
        <form className="chat-form" onSubmit={submit}>
          <input
            ref={inputRef}
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError('');
            }}
            placeholder="Message the table"
            aria-label="Message"
            enterKeyHint="send"
            autoComplete="off"
          />
          <button type="submit" className="btn btn-primary" disabled={sending || Boolean(problem)}>
            {sending ? 'Sending…' : 'Send'}
          </button>
          <span className={tooLong ? 'chat-count over' : 'chat-count'} aria-live="polite">
            {length}/{CHAT_MAX_CHARS}
          </span>
        </form>
        {error ? (
          <p className="error-text small chat-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="muted small chat-note">Messages are kept 24 hours. Plain text only.</p>
      </section>
    </>,
    document.body,
  );
}
