#!/usr/bin/env node
/**
 * Dependency-free validator/normalizer for the negotiated remote-ingress v1 wire.
 *
 * The product contract is authoritative: devspec://product/remote-ingress-contract.
 * This module mirrors its v1 wire shape only because hook scripts deliberately have
 * no package dependencies. Unknown versions and every malformed/cross-field-invalid
 * envelope fail closed at the network boundary.
 */

export const REMOTE_INGRESS_SCHEMA_VERSION = 1
export const REMOTE_INGRESS_CONTRACT_VERSION = '1.2.0'
export const REMOTE_INGRESS_POLICY_VERSION = '2026-08-19.3'
export const REMOTE_INGRESS_RESOURCE_URI = 'devspec://product/remote-ingress-contract'

const CONTRACT_POLICY_PAIRS = new Map([
  ['1.1.0', '2026-08-19.2'],
  ['1.1.1', '2026-08-19.2'],
  [REMOTE_INGRESS_CONTRACT_VERSION, REMOTE_INGRESS_POLICY_VERSION],
])
const SCOPE_AWARE_CONTRACT_VERSION = REMOTE_INGRESS_CONTRACT_VERSION
const SUPPORTED_POLICY_VERSIONS = new Set(CONTRACT_POLICY_PAIRS.values())

const UUID = /^(?:00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$/
const OFFSET_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/
const WAKE_KINDS = new Set([
  'conversational_command',
  'control',
  'advisory_update',
  'history_reseed',
  'idle',
])
const AUTHORITY_KINDS = new Set(['owner', 'delegated'])
const AUTHORITY_MODES = new Set(['owner', 'project', 'allowlist'])
const ACTOR_KINDS = new Set(['human', 'agent', 'ai', 'system'])
const RELATIONSHIPS = new Set(['before_window', 'within_window', 'after_command'])
const OMISSION_REASONS = new Set([
  'policy_limit',
  'model_budget',
  'transport_budget',
  'filter',
  'history_before_window',
  'delivery_retry',
])
const CONTROL_VERBS = new Set(['abort', 'set_model', 'set_thinking', 'compact', 'reload', 'list_models'])
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const CONTEXT_BUCKETS = [
  ['human_context', 'human'],
  ['agent_context', 'agent'],
  ['ai_context', 'ai'],
  ['system_context', 'system'],
]

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, keys) {
  if (!record(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function optionalExactKeys(value, required, optional = []) {
  if (!record(value)) return false
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key))
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0
}

function uuid(value) {
  return typeof value === 'string' && UUID.test(value)
}

function datetime(value) {
  if (typeof value !== 'string') return false
  const match = OFFSET_DATETIME.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] === undefined ? 0 : Number(match[8])
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
  if (
    month < 1 || month > 12 ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}

function nullable(value, predicate) {
  return value === null || predicate(value)
}

function nonnegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0
}

function orderPoint(value) {
  return (
    exactKeys(value, ['sequence', 'created_at', 'message_id']) &&
    positiveInt(value.sequence) &&
    datetime(value.created_at) &&
    uuid(value.message_id)
  )
}

function compareOrder(a, b) {
  return a.sequence - b.sequence
}

function strictlyOrdered(rows) {
  return rows.every((row, index) => index === 0 || compareOrder(rows[index - 1].order, row.order) < 0)
}

function attachment(value) {
  if (!record(value) || value.materialization === 'metadata') {
    return (
      exactKeys(value, [
        'materialization',
        'filename',
        'mime_type',
        'type',
        'size_bytes',
        'resource_id',
      ]) &&
      value.materialization === 'metadata' &&
      nonempty(value.filename) &&
      nonempty(value.mime_type) &&
      nonempty(value.type) &&
      nullable(value.size_bytes, nonnegativeInt) &&
      uuid(value.resource_id)
    )
  }
  if (value.materialization === 'unavailable') {
    return (
      exactKeys(value, [
        'materialization',
        'filename',
        'mime_type',
        'type',
        'size_bytes',
        'resource_id',
        'reason',
      ]) &&
      nonempty(value.filename) &&
      nonempty(value.mime_type) &&
      nonempty(value.type) &&
      nullable(value.size_bytes, nonnegativeInt) &&
      value.resource_id === null &&
      ['missing_resource', 'legacy_inline_payload', 'access_denied'].includes(value.reason)
    )
  }
  return false
}

function addressee(value) {
  return (
    exactKeys(value, ['connection_id', 'agent_name', 'codename', 'label']) &&
    uuid(value.connection_id) &&
    nullable(value.agent_name, nonempty) &&
    nullable(value.codename, nonempty) &&
    nonempty(value.label)
  )
}

function authority(value) {
  if (
    !exactKeys(value, [
      'kind',
      'mode',
      'requested_by_user_id',
      'connection_owner_user_id',
      'decision_source',
    ]) ||
    !AUTHORITY_KINDS.has(value.kind) ||
    !AUTHORITY_MODES.has(value.mode) ||
    !uuid(value.requested_by_user_id) ||
    !uuid(value.connection_owner_user_id) ||
    value.decision_source !== 'server'
  ) return false
  const requesterIsOwner = value.requested_by_user_id === value.connection_owner_user_id
  return (value.kind === 'owner') === requesterIsOwner && !(value.mode === 'owner' && value.kind !== 'owner')
}

export function isRemoteCommandProjectScope(value, authorityKind) {
  if (authorityKind === 'owner') return value === null
  return (
    authorityKind === 'delegated' &&
    exactKeys(value, ['kind', 'policy_id', 'project_id', 'instruction']) &&
    value.kind === 'devspec_project' &&
    value.policy_id === 'delegated_project_v1' &&
    uuid(value.project_id) &&
    nonempty(value.instruction)
  )
}

function command(value, scopeAware) {
  const keys = [
    'message_id',
    'order',
    'content',
    'attachments',
    'requester',
    'authority',
    'addressee',
    'delivery',
    ...(scopeAware ? ['project_scope'] : []),
  ]
  return (
    exactKeys(value, keys) &&
    uuid(value.message_id) &&
    orderPoint(value.order) &&
    value.message_id === value.order.message_id &&
    exactKeys(value.content, ['mode', 'body', 'complete']) &&
    value.content.mode === 'full' &&
    typeof value.content.body === 'string' &&
    value.content.complete === true &&
    Array.isArray(value.attachments) &&
    value.attachments.every(attachment) &&
    exactKeys(value.requester, ['user_id', 'display_name']) &&
    uuid(value.requester.user_id) &&
    nullable(value.requester.display_name, nonempty) &&
    authority(value.authority) &&
    value.requester.user_id === value.authority.requested_by_user_id &&
    (scopeAware
      ? isRemoteCommandProjectScope(value.project_scope, value.authority.kind)
      : value.authority.kind === 'owner') &&
    addressee(value.addressee) &&
    exactKeys(value.delivery, [
      'provenance_ref',
      'turn_id',
      'primary_provenance_ref',
      'is_primary',
    ]) &&
    uuid(value.delivery.provenance_ref) &&
    uuid(value.delivery.turn_id) &&
    uuid(value.delivery.primary_provenance_ref) &&
    typeof value.delivery.is_primary === 'boolean'
  )
}

function actor(value) {
  return (
    exactKeys(value, ['kind', 'user_id', 'display_name', 'agent_tool', 'model']) &&
    ACTOR_KINDS.has(value.kind) &&
    nullable(value.user_id, uuid) &&
    nonempty(value.display_name) &&
    nullable(value.agent_tool, nonempty) &&
    nullable(value.model, nonempty)
  )
}

function contextEntry(value) {
  return (
    exactKeys(value, [
      'message_id',
      'order',
      'actor',
      'source_type',
      'relationship',
      'content',
      'advisory',
    ]) &&
    uuid(value.message_id) &&
    orderPoint(value.order) &&
    value.message_id === value.order.message_id &&
    actor(value.actor) &&
    nonempty(value.source_type) &&
    RELATIONSHIPS.has(value.relationship) &&
    typeof value.content === 'string' &&
    value.advisory === true
  )
}

export function isRemoteIngressTypedContext(value) {
  if (!exactKeys(value, CONTEXT_BUCKETS.map(([name]) => name))) return false
  return CONTEXT_BUCKETS.every(([name, kind]) =>
    Array.isArray(value[name]) &&
    value[name].every((entry) => contextEntry(entry) && entry.actor.kind === kind) &&
    strictlyOrdered(value[name]),
  )
}

export function isRemoteIngressBoundedMetadata(value) {
  if (
    !exactKeys(value, [
      'policy_version',
      'returned',
      'total_known',
      'source_window',
      'truncated',
      'has_more',
      'next_cursor',
      'fetch_id',
      'omission_reason',
    ]) ||
    !SUPPORTED_POLICY_VERSIONS.has(value.policy_version) ||
    !nonnegativeInt(value.returned) ||
    !nullable(value.total_known, nonnegativeInt) ||
    !exactKeys(value.source_window, ['start', 'end']) ||
    !nullable(value.source_window.start, orderPoint) ||
    !nullable(value.source_window.end, orderPoint) ||
    typeof value.truncated !== 'boolean' ||
    typeof value.has_more !== 'boolean' ||
    !nullable(value.next_cursor, nonempty) ||
    !nullable(value.fetch_id, nonempty) ||
    !nullable(value.omission_reason, (reason) => OMISSION_REASONS.has(reason))
  ) return false
  const { start, end } = value.source_window
  if ((start === null) !== (end === null) || (start && end && compareOrder(start, end) > 0)) return false
  if (value.has_more && !value.next_cursor) return false
  if (value.truncated && (!value.omission_reason || !value.fetch_id)) return false
  return value.total_known === null || value.returned <= value.total_known
}

function control(value) {
  if (!optionalExactKeys(value, ['id', 'verb', 'issued_at', 'issued_by_user_id'], ['args'])) return false
  if (!uuid(value.id) || !CONTROL_VERBS.has(value.verb) || !datetime(value.issued_at) || !uuid(value.issued_by_user_id)) {
    return false
  }
  if (Object.hasOwn(value, 'args')) {
    if (!optionalExactKeys(value.args, [], ['model', 'thinking'])) return false
    if (Object.hasOwn(value.args, 'model') && !nonempty(value.args.model)) return false
    if (Object.hasOwn(value.args, 'thinking') && !THINKING_LEVELS.has(value.args.thinking)) return false
  }
  if (value.verb === 'set_model' && !value.args?.model) return false
  return value.verb !== 'set_thinking' || !!value.args?.thinking
}

function sameAddressee(a, b) {
  return (
    a.connection_id === b.connection_id &&
    a.agent_name === b.agent_name &&
    a.codename === b.codename &&
    a.label === b.label
  )
}

function rowsFitWindow(rows, window) {
  if (rows.length === 0) return true
  const { start, end } = window.source_window
  return !!start && !!end && rows.every(
    (row) => compareOrder(row.order, start) >= 0 && compareOrder(row.order, end) <= 0,
  )
}

function envelopeV1(value) {
  if (!exactKeys(value, [
    'kind',
    'schema_version',
    'contract_version',
    'policy_version',
    'envelope_id',
    'connection',
    'wake',
    'delivery_state',
    'command_message_ids',
    'commands',
    'control',
    'context',
    'window',
  ])) return 'ingress must contain exactly the canonical v1 fields'
  if (value.kind !== 'devspec.remote_ingress') return 'unknown ingress kind'
  if (value.schema_version !== REMOTE_INGRESS_SCHEMA_VERSION) return 'unsupported ingress schema_version'
  const pairedPolicy = CONTRACT_POLICY_PAIRS.get(value.contract_version)
  if (!pairedPolicy) return 'unsupported ingress contract_version'
  if (value.policy_version !== pairedPolicy) return 'ingress contract_version/policy_version mismatch'
  if (!uuid(value.envelope_id) || !addressee(value.connection)) return 'invalid envelope identity or connection'
  if (
    !exactKeys(value.wake, ['kind', 'active', 'reason_id']) ||
    !WAKE_KINDS.has(value.wake.kind) ||
    typeof value.wake.active !== 'boolean' ||
    !nonempty(value.wake.reason_id)
  ) return 'invalid wake metadata'
  const activeKind = value.wake.kind === 'conversational_command' || value.wake.kind === 'control'
  if (value.wake.active !== activeKind) return 'wake active flag contradicts kind'
  if (!['live', 'replay', 'reseed'].includes(value.delivery_state)) return 'invalid delivery_state'
  if (value.delivery_state !== 'live' && (value.wake.kind !== 'history_reseed' || value.wake.active)) {
    return 'replay/reseed must be inactive history'
  }
  if (value.wake.kind === 'history_reseed' && value.delivery_state === 'live') {
    return 'history wake requires replay/reseed state'
  }
  if (!Array.isArray(value.command_message_ids) || !value.command_message_ids.every(uuid)) {
    return 'invalid command_message_ids'
  }
  const scopeAware = value.contract_version === SCOPE_AWARE_CONTRACT_VERSION
  if (!Array.isArray(value.commands) || !value.commands.every((entry) => command(entry, scopeAware))) {
    return 'invalid canonical command'
  }
  if ((value.wake.kind === 'control') !== (value.control !== null)) return 'control payload/wake mismatch'
  if (value.control !== null && !control(value.control)) return 'invalid control payload'
  if (
    !isRemoteIngressTypedContext(value.context) ||
    !isRemoteIngressBoundedMetadata(value.window) ||
    value.window.policy_version !== value.policy_version
  ) return 'invalid typed context or window'

  const listedIds = new Set(value.command_message_ids)
  const commandIds = new Set(value.commands.map((entry) => entry.message_id))
  if (
    listedIds.size !== value.command_message_ids.length ||
    commandIds.size !== value.commands.length ||
    commandIds.size !== listedIds.size ||
    value.command_message_ids.some((id) => !commandIds.has(id))
  ) return 'command ids do not exactly match commands'
  if (value.wake.kind === 'conversational_command' && value.commands.length === 0) {
    return 'command wake requires a complete command'
  }
  if (value.commands.some((entry) => !sameAddressee(entry.addressee, value.connection))) {
    return 'command addressee does not exactly match envelope connection'
  }
  if (!strictlyOrdered(value.commands)) return 'commands are not in stable total order'

  const contextRows = CONTEXT_BUCKETS.flatMap(([name]) => value.context[name])
  const allRows = [...value.commands, ...contextRows]
  if (new Set(allRows.map((row) => row.message_id)).size !== allRows.length) {
    return 'command/context records overlap'
  }
  if (value.window.returned !== allRows.length || !rowsFitWindow(allRows, value.window)) {
    return 'canonical window count/range mismatch'
  }
  if (value.commands.length > 0) {
    const turnIds = new Set(value.commands.map((entry) => entry.delivery.turn_id))
    const primaryRefs = new Set(value.commands.map((entry) => entry.delivery.primary_provenance_ref))
    const provenanceRefs = value.commands.map((entry) => entry.delivery.provenance_ref)
    const sharedPrimaryRef = value.commands[0].delivery.primary_provenance_ref
    const primaryFlagsMatch = value.commands.every((entry) =>
      entry.delivery.is_primary === (entry.delivery.provenance_ref === sharedPrimaryRef)
    )
    if (
      turnIds.size !== 1 ||
      primaryRefs.size !== 1 ||
      new Set(provenanceRefs).size !== provenanceRefs.length ||
      !primaryFlagsMatch
    ) return 'command delta does not preserve one immutable turn primary'
  }
  return null
}

/**
 * Validate an ingress value and determine whether it may wake this connection.
 * The returned envelope is the original object: command bytes and all canonical
 * identity/order/delivery/window metadata are never rewritten or summarized.
 */
export function normalizeRemoteIngressV1(input, connectionId) {
  const error = envelopeV1(input)
  if (error) return { ok: false, error }
  if (!uuid(connectionId) || input.connection.connection_id !== connectionId) {
    return { ok: false, error: 'ingress is not for this exact connection' }
  }

  const conversational =
    input.wake.kind === 'conversational_command' &&
    input.wake.active === true &&
    input.delivery_state === 'live'
  if (!conversational) return { ok: true, envelope: input, wake: false, reason: input.wake.kind }

  // Attachments are an atomic part of a command turn. A canonical unavailable
  // descriptor therefore rejects the turn before any inbox wake is written.
  if (input.commands.some((entry) =>
    entry.attachments.some((item) => item.materialization === 'unavailable')
  )) {
    return { ok: true, envelope: input, wake: false, reason: 'unavailable_attachment' }
  }

  return { ok: true, envelope: input, wake: true, commands: input.commands }
}

/** Actor-labelled, explicitly advisory context for a model-facing event. */
export function renderAdvisoryContext(context) {
  if (!isRemoteIngressTypedContext(context)) return []
  return CONTEXT_BUCKETS.flatMap(([bucket]) =>
    context[bucket].map((entry) => ({
      bucket,
      advisory: true,
      actor_label: `${entry.actor.kind.toUpperCase()}: ${entry.actor.display_name}`,
      message_id: entry.message_id,
      order: entry.order,
      source_type: entry.source_type,
      relationship: entry.relationship,
      content: entry.content,
    })),
  ).sort((a, b) => compareOrder(a.order, b.order))
}
