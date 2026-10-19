import { describe, expect, it } from 'vitest'
import {
  ACK_APPLIED,
  AppliedIdLog,
  PROTOCOL_VERSION,
  decodeFrame,
  encodeAck,
  encodeHello,
  encodePong,
  encodeState,
  negotiate,
} from './wear-frames.js'

// The bytes the watch really put on the wire, captured on emulator-5554 against a host listener
// (`docs/notes/08-protocol-transport.md`, probe log RECV line). A decoder tested only against its
// own encoder proves nothing about the other implementation.
const WATCH_HELLO_AS_RECEIVED = '{"v":1,"type":"hello","role":"watch","proto":[1],"sentAt":1791676082855}'

describe('the phone half of the wire format', () => {
  it('decodes the hello the watch actually sent', () => {
    expect(decodeFrame(WATCH_HELLO_AS_RECEIVED)).toEqual({
      type: 'hello',
      role: 'watch',
      proto: [1],
      sentAt: 1791676082855,
    })
  })

  it('encodes a hello the watch-side decoder accepts: role, proto list, sentAt', () => {
    const frame = decodeFrame(encodeHello('phone', 1791676082860))
    expect(frame).toEqual({ type: 'hello', role: 'phone', proto: [PROTOCOL_VERSION], sentAt: 1791676082860 })
  })

  it('round-trips a state frame, absolute deadline and all', () => {
    const projection = {
      workout: {
        id: 'mv2vufc29liyv',
        name: 'Full Body A',
        exerciseIndex: 1,
        exerciseCount: 6,
        exerciseName: 'Dumbbell Bench Press',
        setIndex: 1,
        setCount: 3,
        weightKg: 20,
        reps: 8,
        previousWeightKg: null,
        previousReps: null,
        // M7.1 (plan §2.1): the list rows and the session start travel with the projection.
        startedAt: 1791665000000,
        entries: [
          { index: 0, name: 'Lat Pulldown', setsDone: 3, setsTotal: 3 },
          { index: 1, name: 'Dumbbell Bench Press', setsDone: 0, setsTotal: 3 },
        ],
      },
      rest: { running: true, endsAt: 1791665234842, total: 90, paused: false, left: null, restWhenIdle: 90 },
    }
    const decoded = decodeFrame(encodeState(17, 1791665144842, projection))
    expect(decoded.rev).toBe(17)
    expect(decoded.workout).toEqual(projection.workout)
    expect(decoded.rest).toEqual(projection.rest)
  })

  it('carries workout:null as "no session", not as an error', () => {
    const decoded = decodeFrame(encodeState(1, 5, { workout: null, rest: { running: false, endsAt: null, total: 90, paused: false, left: null, restWhenIdle: 90 } }))
    expect(decoded.workout).toBeNull()
    expect(decoded.rest.running).toBe(false)
  })

  it('round-trips an ack and a pong', () => {
    expect(decodeFrame(encodeAck('c-1-4', ACK_APPLIED, null, 18, 6))).toMatchObject({ id: 'c-1-4', result: 'applied', reason: null, rev: 18 })
    expect(decodeFrame(encodePong(7))).toEqual({ type: 'pong', t: 7 })
  })

  it('decodes the command the watch sends, args included', () => {
    const cmd = decodeFrame('{"v":1,"type":"command","id":"c-1-4","name":"adjustWeight","baseRev":17,"issuedAt":5,"args":{"deltaKg":0.5}}')
    expect(cmd).toEqual({ type: 'command', id: 'c-1-4', name: 'adjustWeight', baseRev: 17, issuedAt: 5, args: { deltaKg: 0.5 } })
  })
})

describe('decoding is total: a bad frame is dropped, the link stays up', () => {
  const bad = [
    '',
    '   ',
    'not json at all',
    '[1,2,3]',
    '"a string"',
    'null',
    '{"v":2,"type":"hello","role":"watch","proto":[1]}',
    '{"type":"hello","role":"watch","proto":[1]}',
    '{"v":1,"type":"hello","role":"fridge","proto":[1]}',
    '{"v":1,"type":"hello","role":"watch","proto":"one"}',
    '{"v":1,"type":"state"}',
    '{"v":1,"type":"state","rev":"17","rest":{"running":false,"total":90,"paused":false}}',
    '{"v":1,"type":"state","rev":1,"workout":{"id":"x"},"rest":{"running":false,"total":90,"paused":false}}',
    '{"v":1,"type":"ack"}',
    '{"v":1,"type":"command","id":"c-1-1"}',
    '{"v":1,"type":"command","id":"c-1-1","name":"completeSet","args":[]}',
    '{"v":1,"type":"whatever"}',
  ]

  it.each(bad)('rejects %j', text => {
    expect(decodeFrame(text)).toBeNull()
  })

  it('never throws, whatever the transport hands it', () => {
    expect(decodeFrame(undefined)).toBeNull()
    expect(decodeFrame(123)).toBeNull()
    expect(decodeFrame('{"v":1,"type":"ping","t":null}')).toEqual({ type: 'ping', t: 0 })
  })
})

describe('version negotiation', () => {
  it('takes the highest common version', () => {
    expect(negotiate([1, 2, 3], [2, 3, 4])).toBe(3)
    expect(negotiate([1], [1])).toBe(1)
  })

  it('is null when the lists do not intersect — an incompatible link, not a fallback', () => {
    expect(negotiate([1], [2])).toBeNull()
    expect(negotiate([1], [])).toBeNull()
  })
})

describe('the applied-id log', () => {
  it('remembers an id, so a replay is answered duplicate rather than applied twice', () => {
    const log = new AppliedIdLog(4)
    expect(log.has('c-1-1')).toBe(false)
    log.remember('c-1-1')
    expect(log.has('c-1-1')).toBe(true)
  })

  it('is bounded and drops the oldest first', () => {
    const log = new AppliedIdLog(3)
    ;['a', 'b', 'c', 'd'].forEach(id => log.remember(id))
    expect(log.size).toBe(3)
    expect(log.has('a')).toBe(false)
    expect(log.has('d')).toBe(true)
  })

  it('does not grow when the same id is applied again', () => {
    const log = new AppliedIdLog(4)
    log.remember('a')
    log.remember('a')
    expect(log.size).toBe(1)
  })
})
