// The poll check: who has voted and who hasn't. Nothing else.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GroupState, PollCheckData, Step } from '../../adapter';
import { matchPoll } from '../../core/match';
import type { CheckResult, Member } from '../../core/types';
import { NeedsReload, NotOnWhatsApp, call } from './api';

type Connection = 'checking' | 'connected' | 'not-whatsapp' | 'reload' | 'error';

const CONNECTION_STEP: Record<Exclude<Connection, 'connected'>, Step> = {
  checking: { label: 'Connecting to WhatsApp Web', ok: false, detail: 'One moment…' },
  'not-whatsapp': { label: 'Connected to WhatsApp Web', ok: false, detail: 'Open web.whatsapp.com in this tab.' },
  reload: { label: 'Connected to WhatsApp Web', ok: false, detail: 'Reload the WhatsApp Web tab once (needed right after installing or updating).' },
  error: { label: 'Connected to WhatsApp Web', ok: false, detail: 'Something went wrong. Reload the WhatsApp Web tab, then tap Refresh.' },
};

type Result =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; check: CheckResult; data: PollCheckData; at: number };

export default function App() {
  const [conn, setConn] = useState<Connection>('checking');
  const [state, setState] = useState<GroupState | null>(null);
  const [pollId, setPollId] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'none' });
  const groupRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const s = await call('getGroupState');
      setConn('connected');
      setState(s);
      // A different group was opened: clear the old result.
      if (s.group?.id !== groupRef.current) {
        groupRef.current = s.group?.id;
        setResult({ kind: 'none' });
      }
      setPollId((cur) => (s.polls.some((p) => p.id === cur) ? cur : (s.polls[0]?.id ?? '')));
    } catch (e) {
      setConn(e instanceof NotOnWhatsApp ? 'not-whatsapp' : e instanceof NeedsReload ? 'reload' : 'error');
      setState(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const check = async () => {
    if (!state?.group || !pollId) return;
    setResult({ kind: 'checking' });
    try {
      const data = await call('checkPoll', state.group.id, pollId);
      setResult({ kind: 'done', check: matchPoll(data.snapshot, data.poll, data.votes), data, at: Date.now() });
    } catch (e) {
      setResult({ kind: 'error', message: e instanceof Error && e.message ? e.message : 'Something went wrong. Tap Check votes again.' });
    }
  };

  const steps: Step[] =
    conn === 'connected' ? [{ label: 'Connected to WhatsApp Web', ok: true }, ...(state?.steps ?? [])] : [CONNECTION_STEP[conn]];
  const ready = conn === 'connected' && !!state?.group && state.polls.length > 0;

  return (
    <main>
      <header>
        <h1>Poll Checker</h1>
        <p className="muted">See who has voted and who hasn't. Reads only, never sends anything.</p>
      </header>

      <section>
        <div className="row">
          <h2>Status</h2>
          <button onClick={() => void refresh()}>Refresh</button>
        </div>
        <ul className="steps">
          {steps.map((s) => (
            <li key={s.label} className={s.ok ? 'ok' : 'bad'}>
              <span className="mark">{s.ok ? '✓' : '✗'}</span>
              <span>
                {s.label}
                {s.detail && <span className={s.ok ? 'muted' : 'hint'}>{s.ok ? ` · ${s.detail}` : s.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {ready && (
        <section>
          <h2>{state.group!.name}</h2>
          <label className="field">
            Poll
            <select value={pollId} onChange={(e) => { setPollId(e.target.value); setResult({ kind: 'none' }); }}>
              {state.polls.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.question || '(poll without a question)'} · {new Date(p.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </label>
          <button className="primary big" onClick={() => void check()} disabled={result.kind === 'checking'}>
            {result.kind === 'checking' ? 'Checking…' : 'Check votes'}
          </button>
          <ResultView result={result} />
        </section>
      )}

      <Details steps={steps} result={result} />
      <footer className="muted">Not affiliated with, endorsed by or sponsored by WhatsApp or Meta.</footer>
    </main>
  );
}

function ResultView({ result }: { result: Result }) {
  const [tab, setTab] = useState<'not' | 'voted' | 'left'>('not');
  const [copied, setCopied] = useState(false);
  if (result.kind === 'none' || result.kind === 'checking') return null;
  if (result.kind === 'error') return <p className="error">{result.message}</p>;

  const { check, data, at } = result;
  if (!check.ok) {
    return (
      <div className="error">
        <p>{check.userMessage}</p>
        <p className="muted">({check.detail})</p>
      </div>
    );
  }

  // A-Z by name; "~ " (people not in your contacts) doesn't change the order.
  const sortKey = (n: string) => n.replace(/^~\s*/, '');
  const byName = (a: { displayName: string }, b: { displayName: string }) => sortKey(a.displayName).localeCompare(sortKey(b.displayName));
  const optionsOf = new Map<string, string[]>();
  for (const o of data.poll.options) {
    for (const m of check.votedByOption[o.id] ?? []) optionsOf.set(m.id, [...(optionsOf.get(m.id) ?? []), o.label]);
  }
  const voted: Member[] = data.snapshot.members.filter((m) => optionsOf.has(m.id)).sort(byName);
  const notVoted = [...check.notVoted].sort(byName);

  const copyNames = async () => {
    await navigator.clipboard.writeText(notVoted.map((m) => m.displayName).join(', '));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="result">
      <p className="big-number">
        {check.summary.notVoted === 0 ? 'Everyone has voted' : `${check.summary.notVoted} haven't voted`}
      </p>
      <p>
        {check.summary.members} members · {check.summary.voted} voted · {check.summary.notVoted} haven't voted
        {check.summary.votedLeft > 0 && ` · ${check.summary.votedLeft} voted, then left`}
      </p>
      <OptionCounts options={data.poll.options} votedByOption={check.votedByOption} voted={check.summary.voted} multipleChoice={data.poll.multipleChoice} />
      <p className="muted">
        Checked at {new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.{' '}
        {data.crossChecked
          ? 'Votes read from two places in WhatsApp Web, and they agree.'
          : 'Votes could be read from one place only. Compare with WhatsApp once to be sure.'}
      </p>

      <div className="tabs">
        <button className={tab === 'not' ? 'on' : ''} onClick={() => setTab('not')}>
          Haven't voted ({notVoted.length})
        </button>
        <button className={tab === 'voted' ? 'on' : ''} onClick={() => setTab('voted')}>
          Voted ({voted.length})
        </button>
        {check.votedLeft.length > 0 && (
          <button className={tab === 'left' ? 'on' : ''} onClick={() => setTab('left')}>
            Voted, then left ({check.votedLeft.length})
          </button>
        )}
      </div>

      {tab === 'not' && (
        <>
          {notVoted.length > 0 && (
            <button className="small-btn" onClick={() => void copyNames()}>
              {copied ? 'Copied ✓' : 'Copy these names'}
            </button>
          )}
          <PeopleList people={notVoted.map((m) => ({ key: m.id, name: m.displayName, sub: m.phone && m.phone !== m.displayName ? m.phone : undefined }))} />
        </>
      )}
      {tab === 'voted' && (
        <PeopleList people={voted.map((m) => ({ key: m.id, name: m.displayName, sub: optionsOf.get(m.id)!.join(', ') }))} />
      )}
      {tab === 'left' && <PeopleList people={check.votedLeft.map((p) => ({ key: p.id, name: p.displayName }))} />}
    </div>
  );
}

/** How many current members picked each option, in the poll's own order. */
function OptionCounts({
  options,
  votedByOption,
  voted,
  multipleChoice,
}: {
  options: { id: string; label: string }[];
  votedByOption: Record<string, Member[]>;
  voted: number;
  multipleChoice: boolean;
}) {
  return (
    <div className="options">
      <h3>
        Votes by option <span className="muted">(out of {voted} who voted)</span>
      </h3>
      <ul>
        {options.map((o) => {
          const n = votedByOption[o.id]?.length ?? 0;
          return (
            <li key={o.id}>
              <span className="label">{o.label}</span>
              <span className="count">{n}</span>
              <span className="bar" style={{ width: `${voted ? (n / voted) * 100 : 0}%` }} />
            </li>
          );
        })}
      </ul>
      {multipleChoice && <p className="muted">People could pick more than one option, so these can add up to more than {voted}.</p>}
    </div>
  );
}

function PeopleList({ people }: { people: { key: string; name: string; sub?: string }[] }) {
  if (people.length === 0) return <p className="muted">Nobody.</p>;
  return (
    <ul className="people">
      {people.map((p) => (
        <li key={p.key}>
          <span>{p.name}</span>
          {p.sub && <span className="muted">{p.sub}</span>}
        </li>
      ))}
    </ul>
  );
}

/** Technical details for Claude: which steps worked and which reading routes were used. No names, numbers or messages. */
function Details({ steps, result }: { steps: Step[]; result: Result }) {
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState('');

  const copy = async () => {
    const diag = await call('getDiagnostics').catch((e: unknown) => ({ unavailable: String(e) }));
    const out = JSON.stringify(
      {
        extensionVersion: browser.runtime.getManifest().version,
        browser: navigator.userAgent,
        steps: steps.map((s) => `${s.ok ? 'OK ' : 'FAIL '}${s.label}`),
        lastResult:
          result.kind === 'done'
            ? result.check.ok
              ? { ok: true, summary: result.check.summary, sources: result.data.sources, crossChecked: result.data.crossChecked }
              : { ok: false, reason: result.check.reason, detail: result.check.detail, sources: result.data.sources }
            : result.kind === 'error'
              ? { error: result.message }
              : result.kind,
        diagnostics: diag,
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
      /* the box below still shows it */
    }
  };

  return (
    <section className="details">
      <div className="row">
        <span className="muted">Something not right? Send these details to Claude. They hold no names, numbers or messages.</span>
        <button onClick={() => void copy()}>{copied ? 'Copied ✓' : 'Copy details for Claude'}</button>
      </div>
      {text && <textarea readOnly value={text} rows={8} />}
    </section>
  );
}
