"""Generates the poll edge-case fixtures in tests/fixtures/polls (PID section 7).
Run: python3 scripts/make-poll-fixtures.py
Every name and number here is made up."""
import json, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'tests', 'fixtures', 'polls')
G = '120363000000000001@g.us'

def phone(n): return f'9198000{n:05d}@c.us'
def lid(n): return f'7700{n:06d}@lid'

def member(n, name, *, kind='phone', admin=False, me=False, both=False):
    if both:
        raw = [phone(n), lid(n)]
    else:
        raw = [phone(n)] if kind == 'phone' else [lid(n)]
    pid = raw[0]
    m = {'id': pid, 'rawIds': raw, 'displayName': name, 'isAdmin': admin, 'isMe': me,
         'canOpenPrivateChat': kind == 'phone' or both}
    if kind == 'phone' or both:
        m['phone'] = '+' + phone(n).split('@')[0]
    return m

def vote(m_or_id, options, raw=None, name=None):
    vid = m_or_id['id'] if isinstance(m_or_id, dict) else m_or_id
    v = {'voterId': vid, 'voterRawIds': raw or (m_or_id['rawIds'] if isinstance(m_or_id, dict) else [vid]), 'optionIds': options}
    if name: v['voterName'] = name
    return v

def poll(voters, *, multiple=False, creator=None, options=('1', '2')):
    labels = {'1': 'Yes', '2': 'No', '3': 'Maybe'}
    return {'id': f'false_{G}_3EB0POLL_{phone(1)}', 'groupId': G, 'question': 'Coming to the meeting on Sunday?',
            'options': [{'id': o, 'label': labels[o]} for o in options], 'multipleChoice': multiple,
            'createdAt': 1759000000000, 'creatorId': creator or phone(1), 'reportedVoterCount': voters}

def snapshot(members, reported=None):
    return {'groupId': G, 'groupName': 'Test society group', 'reportedMemberCount': len(members) if reported is None else reported,
            'members': members, 'readAt': 1759100000000}

def write(name, description, snap, p, votes, expect):
    with open(os.path.join(OUT, f'{name}.json'), 'w') as f:
        json.dump({'description': description, 'snapshot': snap, 'poll': p, 'votes': votes, 'expect': expect}, f, indent=1)

names = ['Aman', 'Gaurav', 'Hansika', 'Priya', 'Rahul']
five = [member(i + 1, n, admin=(i == 0), me=(i == 0)) for i, n in enumerate(names)]
five[0]['displayName'] = 'You'

write('basic-small', 'Five members, three voted.', snapshot(five), poll(3),
      [vote(five[0], ['1']), vote(five[1], ['2']), vote(five[2], ['1'])],
      {'ok': True, 'summary': {'members': 5, 'voted': 3, 'notVoted': 2, 'votedLeft': 0},
       'notVoted': ['Priya', 'Rahul'], 'votedByOption': {'1': ['Hansika', 'You'], '2': ['Gaurav']}})

same = [member(1, 'You', me=True, admin=True), member(2, 'Rahul'), member(3, 'Rahul'), member(4, 'Priya')]
write('duplicate-names', 'Two members called Rahul; only the second voted. Matched by ID, never by name (A1).',
      snapshot(same), poll(2), [vote(same[0], ['1']), vote(same[2], ['1'])],
      {'ok': True, 'summary': {'members': 4, 'voted': 2, 'notVoted': 2, 'votedLeft': 0},
       'notVotedIds': [phone(2), phone(4)]})

write('voted-then-left', 'Someone voted, then left the group: shown under "Voted, left", not counted as a member.',
      snapshot(five), poll(4), [vote(five[0], ['1']), vote(five[1], ['1']), vote(five[2], ['2']), vote(phone(99), ['2'], name='Vikram')],
      {'ok': True, 'summary': {'members': 5, 'voted': 3, 'notVoted': 2, 'votedLeft': 1},
       'notVoted': ['Priya', 'Rahul'], 'votedLeft': ['Vikram']})

joined = five + [member(6, 'Neha')]
write('joined-after-poll', 'Neha joined after the poll was created: counted as "haven\'t voted".',
      snapshot(joined), poll(3), [vote(joined[0], ['1']), vote(joined[1], ['1']), vote(joined[2], ['1'])],
      {'ok': True, 'summary': {'members': 6, 'voted': 3, 'notVoted': 3, 'votedLeft': 0}, 'notVoted': ['Neha', 'Priya', 'Rahul']})

write('multiple-choice', 'Multiple-choice poll: a voter counts once; per-option counts add up to more than the voters.',
      snapshot(five), poll(2, multiple=True, options=('1', '2', '3')), [vote(five[1], ['1', '3']), vote(five[2], ['1', '2', '3'])],
      {'ok': True, 'summary': {'members': 5, 'voted': 2, 'notVoted': 3, 'votedLeft': 0},
       'votedByOption': {'1': ['Gaurav', 'Hansika'], '2': ['Hansika'], '3': ['Gaurav', 'Hansika']}})

write('poll-by-someone-else', 'Poll created by another member, and the user is not an admin: works the same.',
      snapshot([dict(m, isAdmin=False) for m in five]), poll(1, creator=phone(4)), [vote(five[3], ['2'])],
      {'ok': True, 'summary': {'members': 5, 'voted': 1, 'notVoted': 4, 'votedLeft': 0}})

write('zero-votes', 'Nobody has voted yet.', snapshot(five), poll(0), [],
      {'ok': True, 'summary': {'members': 5, 'voted': 0, 'notVoted': 5, 'votedLeft': 0}})

write('everyone-voted', 'Everyone has voted.', snapshot(five), poll(5), [vote(m, ['1']) for m in five],
      {'ok': True, 'summary': {'members': 5, 'voted': 5, 'notVoted': 0, 'votedLeft': 0}, 'notVoted': []})

hidden = [member(1, 'You', me=True, both=True), member(2, '~ Kiran', kind='lid'), member(3, '~ Sonal', kind='lid'), member(4, '~ Dev', kind='lid')]
write('hidden-numbers', 'WhatsApp hides members\' numbers (privacy IDs only): shown by visible name, no private chat.',
      snapshot(hidden), poll(2), [vote(hidden[1], ['1']), vote(hidden[0], ['1'], raw=[lid(1)])],
      {'ok': True, 'summary': {'members': 4, 'voted': 2, 'notVoted': 2, 'votedLeft': 0}, 'notVoted': ['~ Dev', '~ Sonal']})

mixed = [member(1, 'You', me=True, both=True), member(2, 'Gaurav', both=True), member(3, 'Hansika', both=True)]
write('mixed-ids-resolved', 'A vote arrives under the privacy ID of a member listed by phone. Resolved to one person (A2).',
      snapshot(mixed), poll(1), [{'voterId': phone(2), 'voterRawIds': [phone(2), lid(2)], 'optionIds': ['1']}],
      {'ok': True, 'summary': {'members': 3, 'voted': 1, 'notVoted': 2, 'votedLeft': 0}, 'notVoted': ['Hansika', 'You']})

write('unresolved-voter-bad-id', 'A vote with no usable WhatsApp ID: error, no list.',
      snapshot(five), poll(1), [{'voterId': 'something-odd', 'voterRawIds': ['something-odd'], 'optionIds': ['1']}],
      {'ok': False, 'reason': 'UNRESOLVED_VOTER'})

lidonly = [member(1, 'You', me=True, kind='lid'), member(2, '~ Kiran', kind='lid')]
write('unresolved-voter-incomparable', 'Members are known only by privacy ID, a voter only by phone ID. They might be the same person, so: error, no list.',
      snapshot(lidonly), poll(1), [vote(phone(2), ['1'])], {'ok': False, 'reason': 'UNRESOLVED_VOTER'})

write('member-count-mismatch', 'Read 5 members but WhatsApp says 40 (member list not fully loaded): error, no list.',
      snapshot(five, reported=40), poll(1), [vote(five[1], ['1'])], {'ok': False, 'reason': 'MEMBER_COUNT_MISMATCH'})

write('vote-count-mismatch', 'Read 1 voter but WhatsApp shows 3: error, no list.',
      snapshot(five), poll(3), [vote(five[1], ['1'])], {'ok': False, 'reason': 'VOTE_COUNT_MISMATCH'})

dup = five + [five[1]]
write('balance-failed', 'The same voter appears twice in the member list, so the maths cannot balance: error, no list.',
      snapshot(dup), poll(1), [vote(five[1], ['1'])], {'ok': False, 'reason': 'BALANCE_FAILED'})

write('unknown-option', 'A vote points to an option that is not on the poll: paused, no list.',
      snapshot(five), poll(1), [vote(five[1], ['9'])], {'ok': False, 'reason': 'ADAPTER_ERROR'})

wrong = poll(0); wrong['groupId'] = '120363000000000999@g.us'
write('wrong-group', 'Poll and member list come from different groups: paused, no list.',
      snapshot(five), wrong, [], {'ok': False, 'reason': 'ADAPTER_ERROR'})

big = [member(i, f'Member {i:04d}', me=(i == 1)) for i in range(1, 1025)]
big_votes = [vote(m, ['1' if i % 3 else '2']) for i, m in enumerate(big) if i % 4 != 0]
write('large-group', 'A 1,024-member group with 768 voters.', snapshot(big), poll(len(big_votes)), big_votes,
      {'ok': True, 'summary': {'members': 1024, 'voted': 768, 'notVoted': 256, 'votedLeft': 0}})
print('fixtures written:', len(os.listdir(OUT)))
