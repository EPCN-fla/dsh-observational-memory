/**
 * The Observational Memory settings card: one expandable card at the bottom
 * of Settings → Plugins → Plugin configuration. Owns its chrome and controls
 * (the bundle-purity gate forbids importing the shipped cards' components).
 */
import { useEffect, useRef, useState } from 'react'
import type { LocaleKey } from './locales.ts'
import type { OmCardFace, OmCardState } from './controller.ts'
import css from './card.module.css'

export type Translate = (key: LocaleKey) => string

/** Props the slot renderer composes for the card. */
export interface ObservationalMemoryCardProps {
  t: Translate
  /** Selector hook synthesized from the inject face's `hooks.omCard` store. */
  useOmCard: <S>(selector: (state: OmCardState) => S) => S
  edit: OmCardFace['edit']
  resetField: OmCardFace['resetField']
  save: OmCardFace['save']
  discard: OmCardFace['discard']
  retryCatalog: OmCardFace['retryCatalog']
}

interface NumberFieldDef {
  key: string
  labelKey: LocaleKey
  hintKey: LocaleKey
  min?: number
}

/** Number fields rendered above the compaction-threshold mode switch. */
const TOP_NUMBER_FIELDS: NumberFieldDef[] = [
  { key: 'observeAfterTokens', labelKey: 'field.observeAfterTokens', hintKey: 'field.observeAfterTokensHint', min: 1 },
  { key: 'reflectAfterTokens', labelKey: 'field.reflectAfterTokens', hintKey: 'field.reflectAfterTokensHint', min: 1 },
  { key: 'observerChunkMaxTokens', labelKey: 'field.observerChunkMaxTokens', hintKey: 'field.observerChunkMaxTokensHint', min: 256 },
]

/** Number fields rendered below the mode-dependent compaction threshold. */
const BOTTOM_NUMBER_FIELDS: NumberFieldDef[] = [
  { key: 'observationsPoolMaxTokens', labelKey: 'field.observationsPoolMaxTokens', hintKey: 'field.observationsPoolMaxTokensHint', min: 1 },
  { key: 'observationsPoolTargetTokens', labelKey: 'field.observationsPoolTargetTokens', hintKey: 'field.observationsPoolTargetTokensHint', min: 1 },
  { key: 'agentMaxTurns', labelKey: 'field.agentMaxTurns', hintKey: 'field.agentMaxTurnsHint', min: 1 },
]

/** The threshold field each compaction-threshold mode shows; the other is inert. */
const MODE_THRESHOLD_FIELD: Record<string, NumberFieldDef> = {
  calibrated: { key: 'compactAfterTokens', labelKey: 'field.compactAfterTokens', hintKey: 'field.compactAfterTokensHint', min: 0 },
  ratio: { key: 'compactAfterTokensRatio', labelKey: 'field.compactAfterTokensRatio', hintKey: 'field.compactAfterTokensRatioHint' },
}

const MODE_FIELD: { key: string; labelKey: LocaleKey; hintKey: LocaleKey; options: readonly string[] } = {
  key: 'compactAfterTokensMode',
  labelKey: 'field.compactAfterTokensMode',
  hintKey: 'field.compactAfterTokensModeHint',
  options: ['calibrated', 'ratio'],
}

const BOOLEAN_FIELDS: { key: string; labelKey: LocaleKey; hintKey: LocaleKey }[] = [
  { key: 'passive', labelKey: 'field.passive', hintKey: 'field.passiveHint' },
  { key: 'showWorkerNotifications', labelKey: 'field.showWorkerNotifications', hintKey: 'field.showWorkerNotificationsHint' },
  { key: 'debugLog', labelKey: 'field.debugLog', hintKey: 'field.debugLogHint' },
]

function ValueField(props: {
  id: string
  label: string
  hint: string
  text: string
  overridden: boolean
  invalid: boolean
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden ? (
          <span className={css.badges}>
            <span className={css.tag}>{props.overriddenLabel}</span>
            <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type="text"
        value={props.text}
        disabled={props.disabled}
        aria-invalid={props.invalid || undefined}
        onChange={(event) => props.onEdit(event.target.value)}
      />
      <p className={props.invalid ? css.invalid : css.hint}>{props.invalid ? props.invalidLabel : props.hint}</p>
    </div>
  )
}

function ChoiceField(props: {
  id: string
  label: string
  hint: string
  text: string
  options: readonly string[]
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden ? (
          <span className={css.badges}>
            <span className={css.tag}>{props.overriddenLabel}</span>
            <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      <select
        id={props.id}
        className={css.input}
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => props.onEdit(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}

function ToggleField(props: {
  id: string
  label: string
  hint: string
  checked: boolean
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onEdit: (checked: boolean) => void
  onReset: () => void
}) {
  return (
    <div className={css.fieldRow}>
      <input
        id={props.id}
        className={css.checkbox}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onEdit(event.target.checked)}
      />
      <div className={css.rowText}>
        <label className={css.label} htmlFor={props.id}>
          {props.label}
          {props.overridden ? <span className={css.tagInline}>{props.overriddenLabel}</span> : null}
          {props.overridden ? (
            <button type="button" className={css.reset} disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          ) : null}
        </label>
        <p className={css.hint}>{props.hint}</p>
      </div>
    </div>
  )
}

/** One option of a model-cascade dropdown. */
interface SelectOption {
  value: string
  label: string
}

/**
 * Keep the currently stored value selectable even when the live catalog no
 * longer advertises it, so a vanished route is shown (and clearable) rather
 * than silently dropped from the draft.
 */
function withCurrent(options: readonly SelectOption[], current: string, unavailableLabel: string): SelectOption[] {
  if (current !== '' && !options.some((option) => option.value === current)) {
    return [...options, { value: current, label: `${current} (${unavailableLabel})` }]
  }
  return [...options]
}

function named(id: string, name: string): string {
  return name === id ? id : `${name} (${id})`
}

/** One dropdown of the provider → model → reasoning-effort cascade. */
function ModelSelect(props: {
  id: string
  label: string
  value: string
  options: readonly SelectOption[]
  disabled: boolean
  invalid?: boolean
  onEdit: (value: string) => void
}) {
  return (
    <div className={css.modelField}>
      <label className={css.label} htmlFor={props.id}>{props.label}</label>
      <select
        id={props.id}
        className={props.invalid === true ? css.inputInvalid : css.input}
        value={props.value}
        disabled={props.disabled}
        aria-invalid={props.invalid === true || undefined}
        onChange={(event) => props.onEdit(event.target.value)}
      >
        {props.options.map((option) => (
          <option key={option.value === '' ? '__blank__' : option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  )
}

export function ObservationalMemoryCard(props: ObservationalMemoryCardProps) {
  const { t } = props
  const state = props.useOmCard((snapshot) => snapshot)
  const [open, setOpen] = useState(false)
  const saveStarted = useRef(false)

  // Collapse only after a Host-confirmed save; a failed write keeps its
  // diagnostics and drafts visible for correction.
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) setOpen(false)
  }, [state.dirty, state.failed, state.saving])

  if (!state.available) return null

  const disabled = !state.writable
  const modelInvalid =
    (state.fields['model.provider']?.text.trim() === '') !== (state.fields['model.id']?.text.trim() === '')
  const blocked = !state.dirty || state.invalid || state.saving || modelInvalid

  // Only the threshold parameter the selected mode shows is rendered (and
  // effective); the other stays hidden whatever it is set to.
  const thresholdMode = state.fields.compactAfterTokensMode?.text === 'ratio' ? 'ratio' : 'calibrated'
  const thresholdField = MODE_THRESHOLD_FIELD[thresholdMode]

  const renderNumberField = (field: NumberFieldDef) => (
    <ValueField
      key={field.key}
      id={`om-${field.key}`}
      label={t(field.labelKey)}
      hint={t(field.hintKey)}
      overriddenLabel={t('state.overridden')}
      resetLabel={t('action.reset')}
      invalidLabel={t(field.key === 'compactAfterTokensRatio' ? 'state.invalidRatio' : 'state.invalidNumber')}
      disabled={disabled}
      {...state.fields[field.key]}
      onEdit={(text) => props.edit(field.key, text)}
      onReset={() => props.resetField(field.key)}
    />
  )

  // Provider → model → reasoning-effort cascade over the Host model catalog:
  // a downstream dropdown stays empty while its upstream pick is unset.
  const providerText = state.fields['model.provider']?.text ?? ''
  const modelText = state.fields['model.id']?.text ?? ''
  const effortText = state.fields['model.reasoningEffort']?.text ?? ''
  const group = state.catalog.find((entry) => entry.id === providerText)
  const modelEntry = group?.models.find((entry) => entry.id === modelText)
  const unavailableLabel = t('state.optionUnavailable')

  const providerOptions = withCurrent(
    [
      { value: '', label: t('field.modelFollowSession') },
      ...state.catalog.map((entry) => ({ value: entry.id, label: named(entry.id, entry.name) })),
    ],
    providerText,
    unavailableLabel,
  )
  const modelOptions = providerText === ''
    ? []
    : withCurrent(
      [
        { value: '', label: t('field.modelSelect') },
        ...(group?.models ?? []).map((entry) => ({ value: entry.id, label: named(entry.id, entry.name) })),
      ],
      modelText,
      unavailableLabel,
    )
  const effortOptions = modelText === ''
    ? []
    : withCurrent(
      [
        { value: '', label: t('field.modelEffortDefault') },
        ...(modelEntry?.reasoning?.efforts ?? []).map((entry) => ({ value: entry.id, label: named(entry.id, entry.name) })),
      ],
      effortText,
      unavailableLabel,
    )

  return (
    <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'state.collapse' : 'state.expand')}: ${t('card.title')}`}
        onClick={() => setOpen(!open)}
      >
        <span className={css.headText}>
          <span className={css.name}>{t('card.title')}</span>
          <span className={css.description}>{t('card.description')}</span>
        </span>
        {state.dirty ? <span className={css.tag}>{t('state.unsaved')}</span> : null}
        <span className={`${css.chevron} ${open ? css.chevronOpen : ''}`} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className={css.body}>
          {!state.writable ? <p className={css.readOnly} role="status">{t('state.readOnly')}</p> : null}

          <h4 className={css.section}>{t('section.thresholds')}</h4>
          {TOP_NUMBER_FIELDS.map(renderNumberField)}
          <ChoiceField
            id={`om-${MODE_FIELD.key}`}
            label={t(MODE_FIELD.labelKey)}
            hint={t(MODE_FIELD.hintKey)}
            options={MODE_FIELD.options}
            overriddenLabel={t('state.overridden')}
            resetLabel={t('action.reset')}
            disabled={disabled}
            text={state.fields[MODE_FIELD.key]?.text ?? MODE_FIELD.options[0]}
            overridden={state.fields[MODE_FIELD.key]?.overridden ?? false}
            onEdit={(text) => props.edit(MODE_FIELD.key, text)}
            onReset={() => props.resetField(MODE_FIELD.key)}
          />
          {renderNumberField(thresholdField)}
          {BOTTOM_NUMBER_FIELDS.map(renderNumberField)}

          <h4 className={css.section}>{t('section.model')}</h4>
          <p className={css.hint}>{t('field.modelHint')}</p>
          {state.catalogStatus === 'loading' ? <p className={css.hint}>{t('state.catalogLoading')}</p> : null}
          {state.catalogStatus === 'error' ? (
            <p className={css.invalid}>
              {t('state.catalogFailed')}{' '}
              <button type="button" className={css.reset} disabled={disabled} onClick={props.retryCatalog}>
                {t('action.retry')}
              </button>
            </p>
          ) : null}
          <div className={css.modelRow}>
            <ModelSelect
              id="om-model.provider"
              label={t('field.modelProvider')}
              value={providerText}
              options={providerOptions}
              disabled={disabled}
              invalid={modelInvalid}
              onEdit={(value) => props.edit('model.provider', value)}
            />
            <ModelSelect
              id="om-model.id"
              label={t('field.modelId')}
              value={modelText}
              options={modelOptions}
              disabled={disabled || providerText === ''}
              invalid={modelInvalid}
              onEdit={(value) => props.edit('model.id', value)}
            />
            <ModelSelect
              id="om-model.reasoningEffort"
              label={t('field.modelReasoningEffort')}
              value={effortText}
              options={effortOptions}
              disabled={disabled || modelText === ''}
              onEdit={(value) => props.edit('model.reasoningEffort', value)}
            />
          </div>
          {modelInvalid ? <p className={css.invalid}>{t('state.invalidModel')}</p> : null}
          {renderNumberField({
            key: 'modelFallbackAfterFailures',
            labelKey: 'field.modelFallbackAfterFailures',
            hintKey: 'field.modelFallbackAfterFailuresHint',
            min: 0,
          })}

          <h4 className={css.section}>{t('section.advanced')}</h4>
          {BOOLEAN_FIELDS.map((field) => (
            <ToggleField
              key={field.key}
              id={`om-${field.key}`}
              label={t(field.labelKey)}
              hint={t(field.hintKey)}
              checked={state.fields[field.key]?.text === 'true'}
              overridden={state.fields[field.key]?.overridden ?? false}
              overriddenLabel={t('state.overridden')}
              resetLabel={t('action.reset')}
              disabled={disabled}
              onEdit={(checked) => props.edit(field.key, String(checked))}
              onReset={() => props.resetField(field.key)}
            />
          ))}
          <ValueField
            id="om-storageDir"
            label={t('field.storageDir')}
            hint={t('field.storageDirHint')}
            overriddenLabel={t('state.overridden')}
            resetLabel={t('action.reset')}
            invalidLabel={t('state.invalidNumber')}
            disabled={disabled}
            {...state.fields.storageDir}
            onEdit={(text) => props.edit('storageDir', text)}
            onReset={() => props.resetField('storageDir')}
          />

          <div className={css.footer}>
            {state.failed ? <p className={css.failed} role="status">{t('state.saveFailed')}</p> : null}
            <button
              type="button"
              className={css.discard}
              disabled={!state.dirty || state.saving}
              onClick={props.discard}
            >
              {t('action.discard')}
            </button>
            <button type="button" className={css.save} disabled={blocked} onClick={props.save}>
              {t(state.saving ? 'action.saving' : 'action.save')}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
