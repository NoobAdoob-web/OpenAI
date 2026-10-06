// Phase 0 debug panel: status, health check, poll summary and coverage report.
// It is deliberately bare. The real screens arrive in Phase 1.

import { useCallback, useEffect, useState } from 'react';
import type { PollSummary, PollVotesResult } from '../../adapter/polls';
import { describeCoverage, type CoverageSourceReport } from '../../core/coverage';
import { matchPoll } from '../../core/match';
import type { ChatInfo, CheckResult, GroupSnapshot, Member, SelfTestResult } from '../../core/types';
import { NeedsReload, NotOnWhatsApp, call } from './api';

type PanelStatus = 'checking' | 'ready' | 'open' | 'reload' | 'log-in' | 'paused';

const STATUS_TEXT: Record<PanelStatus, string> = {
  checking: 'Checking…',
  ready: 'Ready',
  open: 'Open WhatsApp Web',
  reload: 'Reload WhatsApp Web',
  'log-in': 'Log in to WhatsApp Web',
  paused: 'Paused for update',
};

function time(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function statusFromError(e: unknown): PanelStatus {
  if (e instanceof NotOnWhatsApp) return 'open';
  if (e instanceof NeedsReload) return 'reload';
  return 'paused';
}

export default function App() {
  const [status, setStatus] = useState<PanelStatus>('checking');
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);
  const [chat, setChat] = useState<ChatInfo | null>(null);
  const [coverage, setCoverage] = useState<CoverageResult | null>(null);

  const refreshStatus = useCallback(async (withSelfTest: boolean) => {
    try {
      const s = await call('getStatus');
      setChat(s === 'ready' ? await call('getActiveChat') : null);
      if (s !== 'ready') {
        setStatus(s);
        return;
      }
      if (withSelfTest) {
        const t = await call('runSelfTest');
        setSelfTest(t);
        setStatus(t.ok ? 'ready' : 'paused');
      } else {
        setStatus((prev) => (prev === 'paused' ? 'paused' : 'ready'));
      }
    } catch (e) {
      setStatus(statusFromError(e));
      setChat(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus(true);
    // Rule F1: status follows log in, log out and chat switches within 2 seconds.
    const t = setInterval(() => void refreshStatus(false), 2000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  // Re-run the self-test whenever the user opens a different chat.
  const chatId = chat?.id;
  useEffect(() => {
    if (chatId) void refreshStatus(true);
  }, [chatId, refreshStatus]);

  return (
    <main>
      <header>
        <div>
          <h1>ChatLens</h1>
          <p className="muted">Phase 0 test build · reads only, never sends</p>
        </div>
        <span className={`pill pill-${status}`}>{STATUS_TEXT[status]}</span>
      </header>

      {status === 'open' && <p>Open <b>web.whatsapp.com</b> in this tab, then come back here.</p>}
      {status === 'reload' && <p>Reload the WhatsApp Web tab once (the extension was just installed or updated).</p>}
      {status === 'log-in' && <p>Log in to WhatsApp Web with your test number.</p>}

      <HealthCheck result={selfTest} onRefresh={() => void refreshStatus(true)} />
      {status === 'ready' && <PollCheck chat={chat} />}
      {(status === 'ready' || status === 'paused') && <Coverage report={coverage} onReport={setCoverage} />}
      {(status === 'ready' || status === 'paused') && <Diagnostics selfTest={selfTest} coverage={coverage} />}

      <footer className="muted">Not affiliated with, endorsed by or sponsored by WhatsApp or Meta.</footer>
    </main>
  );
}

function HealthCheck({ result, onRefresh }: { result: SelfTestResult | null; onRefresh: () => void }) {
  return (
    <section>
      <div className="row">
        <h2>Health check</h2>
        <button onClick={onRefresh}>Refresh</button>
      </div>
      {!result && <p className="muted">Not run yet.</p>}
      {result && (
        <ul className="checks">
          {result.checks.map((c) => (
            <li key={c.name} className={c.ok ? 'ok' : 'bad'}>
              <span>{c.ok ? '✓' : '✗'}</span> {c.name}
              {c.note && <span className="muted"> · {c.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type PollState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: CheckResult; votes: PollVotesResult; snapshot: GroupSnapshot; at: number };

function PollCheck({ chat }: { chat: ChatInfo | null }) {
  const [polls, setPolls] = useState<PollSummary[]>([]);
  const [pollId, setPollId] = useState('');
  const [state, setState] = useState<PollState>({ kind: 'idle' });
  const [tab, setTab] = useState<'not' | 'voted' | 'left'>('not');
  const [hideMe, setHideMe] = useState(false);
  const [hideAdmins, setHideAdmins] = useState(false);

  const isGroup = !!chat && chat.type !== 'individual';
  // The status check hands us a fresh chat object every 2 seconds, so depend on
  // the chat's ID: results must only clear when the user switches chats.
  const chatId = isGroup ? chat.id : undefined;

  const loadPolls = useCallback(async () => {
    if (!chatId) return;
    try {
      const list = await call('listPolls', chatId);
      setPolls(list);
      setPollId((cur) => (list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? '')));
    } catch {
      setPolls([]);
    }
  }, [chatId]);

  useEffect(() => {
    setState({ kind: 'idle' });
    void loadPolls();
  }, [loadPolls]);

  const check = async () => {
    if (!chat || !pollId) return;
    setState({ kind: 'loading' });
    try {
      // Rule A5: always read fresh.
      const test = await call('runSelfTest');
      if (!test.ok) throw new Error('The health check failed, so we paused. See the health check above.');
      const snapshot = await call('getGroupSnapshot', chat.id);
      const votes = await call('getPollVotes', pollId);
      setState({ kind: 'done', result: matchPoll(snapshot, votes.poll, votes.votes), votes, snapshot, at: Date.now() });
    } catch (e) {
      const message =
        e instanceof Error && e.message ? e.message : 'Something went wrong while reading. Tap Check poll again.';
      setState({ kind: 'error', message });
    }
  };

  const visible = (ms: Member[]) => ms.filter((m) => !(hideMe && m.isMe) && !(hideAdmins && m.isAdmin)).sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <section>
      <div className="row">
        <h2>Poll Chaser test</h2>
        <button onClick={() => void loadPolls()} disabled={!isGroup}>
          Reload polls
        </button>
      </div>
      {!chat && <p className="muted">Open a group in WhatsApp Web.</p>}
      {chat && !isGroup && <p className="muted">“{chat.name}” is not a group. Open a group with a poll.</p>}
      {isGroup && chat.isAnnouncementGroup && (
        <p className="warn">This is a community announcement group. Poll Chaser doesn't support these yet (V1).</p>
      )}
      {isGroup && (
        <>
          <p>
            Group: <b>{chat.name}</b>
          </p>
          {polls.length === 0 ? (
            <p className="muted">No polls loaded in this chat. Scroll up to your poll, then tap Reload polls.</p>
          ) : (
            <div className="row">
              <select value={pollId} onChange={(e) => setPollId(e.target.value)}>
                {polls.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.question || '(no question)'} · {p.creatorName} · {new Date(p.createdAt).toLocaleDateString()}
                  </option>
                ))}
              </select>
              <button className="primary" onClick={() => void check()} disabled={state.kind === 'loading'}>
                {state.kind === 'loading' ? 'Checking…' : 'Check poll'}
              </button>
            </div>
          )}
        </>
      )}

      {state.kind === 'error' && <p className="bad">{state.message}</p>}
      {state.kind === 'done' && !state.result.ok && (
        <div className="bad">
          <p>{state.result.userMessage}</p>
          <p className="muted">Detail: {state.result.reason} · {state.result.detail}</p>
        </div>
      )}
      {state.kind === 'done' && state.result.ok && (
        <div>
          <p className="summary">
            {state.result.summary.members} members · {state.result.summary.voted} voted · {state.result.summary.notVoted} haven't voted
            {state.result.summary.votedLeft > 0 && ` · ${state.result.summary.votedLeft} voted, then left`}
          </p>
          <p className="muted">Checked at {time(state.at)}</p>
          {!state.votes.independentlyVerified && (
            <p className="warn">
              Phase 0 note: the vote total could only be read from one place, so it is not independently verified.
              Compare these numbers with WhatsApp by hand.
            </p>
          )}
          <div className="tabs">
            <button className={tab === 'not' ? 'on' : ''} onClick={() => setTab('not')}>
              Haven't voted ({state.result.notVoted.length})
            </button>
            <button className={tab === 'voted' ? 'on' : ''} onClick={() => setTab('voted')}>
              Voted
            </button>
            <button className={tab === 'left' ? 'on' : ''} onClick={() => setTab('left')}>
              Voted, left ({state.result.votedLeft.length})
            </button>
          </div>
          <div className="row small">
            <label>
              <input type="checkbox" checked={hideMe} onChange={(e) => setHideMe(e.target.checked)} /> Hide “You”
            </label>
            <label>
              <input type="checkbox" checked={hideAdmins} onChange={(e) => setHideAdmins(e.target.checked)} /> Hide admins
            </label>
          </div>
          {tab === 'not' && <People list={visible(state.result.notVoted)} />}
          {tab === 'voted' &&
            state.votes.poll.options.map((o) => (
              <div key={o.id}>
                <h3>
                  {o.label} ({state.result.ok ? state.result.votedByOption[o.id]?.length : 0})
                </h3>
                <People list={state.result.ok ? visible(state.result.votedByOption[o.id] ?? []) : []} />
              </div>
            ))}
          {tab === 'left' && (
            <ul className="people">
              {state.result.votedLeft.map((p) => (
                <li key={p.id}>{p.displayName}</li>
              ))}
              {state.result.votedLeft.length === 0 && <li className="muted">Nobody.</li>}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function People({ list }: { list: Member[] }) {
  if (list.length === 0) return <p className="muted">Nobody.</p>;
  return (
    <ul className="people">
      {list.map((m) => (
        <li key={m.id}>
          {m.displayName}
          {m.phone && m.phone !== m.displayName && <span className="muted"> · {m.phone}</span>}
          {m.isAdmin && <span className="tag">admin</span>}
        </li>
      ))}
    </ul>
  );
}

type CoverageResult = { memory: CoverageSourceReport; database: CoverageSourceReport; databaseFields: string[] };

function Coverage({ report, onReport }: { report: CoverageResult | null; onReport: (r: CoverageResult) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      onReport(await call('measureCoverage'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="row">
        <h2>Search coverage report</h2>
        <button className="primary" onClick={() => void run()} disabled={busy}>
          {busy ? 'Measuring…' : 'Measure'}
        </button>
      </div>
      <p className="muted">Counts how much message history this computer holds. Reads counts only; no text is kept.</p>
      {error && <p className="bad">{error}</p>}
      {report &&
        [report.memory, report.database].map((r) => (
          <ul key={r.source} className="report">
            {describeCoverage(r).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ))}
    </section>
  );
}

function Diagnostics({ selfTest, coverage }: { selfTest: SelfTestResult | null; coverage: CoverageResult | null }) {
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);

  const build = async () => {
    const diag = await call('getDiagnostics').catch((e: unknown) => ({ error: String(e) }));
    const out = JSON.stringify(
      {
        extensionVersion: browser.runtime.getManifest().version,
        diagnostics: diag,
        selfTest,
        coverage,
      },
      null,
      2,
    );
    setText(out);
    try {
      await navigator.clipboard.writeText(out);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the text box below still shows it */
    }
  };

  return (
    <section>
      <div className="row">
        <h2>Diagnostics</h2>
        <button onClick={() => void build()}>{copied ? 'Copied ✓' : 'Copy diagnostics'}</button>
      </div>
      <p className="muted">
        Technical facts about how the reading worked: versions, which data sources were found, counts. No names, numbers or
        messages. Paste this back to Claude after testing.
      </p>
      {text && <textarea readOnly value={text} rows={10} />}
    </section>
  );
}
