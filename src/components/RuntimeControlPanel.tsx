import { ArrowsClockwise, CheckCircle, Cpu, PlugsConnected, WarningCircle } from '@phosphor-icons/react'
import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import type { AiRuntimeStatus, RuntimeSelection } from '../types'

interface Props {
  status: AiRuntimeStatus | null
  loading: boolean
  value: RuntimeSelection
  onChange: (value: RuntimeSelection) => void
  onRefresh: () => void
  context?: 'default' | 'verification' | 'detail-redraw'
}

export default function RuntimeControlPanel({ status, loading, value, onChange, onRefresh, context = 'default' }: Props) {
  const panelRef = useRef<HTMLElement>(null)
  const selectedProvider = status?.providers.find(provider => provider.id === value.providerId)
  const connected = Boolean(status?.available && (value.providerId !== 'codex' || status.authenticated))
  const boundSkillId = context === 'verification' ? 'chair-result-verifier' : context === 'detail-redraw' ? 'chair-detail-restorer' : 'chair-angle-matcher'
  const boundSkill = status?.skills.find(skill => skill.id === boundSkillId)
  const angleSkills = status?.skills.filter(skill => skill.id === 'chair-angle-matcher') || []

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.runtime-field', { autoAlpha: 0, y: 12 }, {
        autoAlpha: 1, y: 0, duration: 0.34, stagger: 0.055, ease: 'power2.out', clearProps: 'transform,opacity,visibility',
      })
    })
    return () => media.revert()
  }, { scope: panelRef })

  const patch = (next: Partial<RuntimeSelection>) => onChange({ ...value, ...next })

  return (
    <section className="runtime-control-panel" ref={panelRef} aria-label="模型运行时配置">
      <div className="runtime-panel-heading">
        <div className="runtime-heading-copy">
          <span className="runtime-heading-icon"><Cpu size={22} weight="bold" /></span>
          <div>
            <strong>后台模型接入</strong>
            <small>{context === 'verification'
              ? '供应商、模型和思考强度用于生成结果核验；核验 Skill 在下方独立绑定。'
              : context === 'detail-redraw'
                ? '供应商、模型和思考强度用于局部识别、裁切与重绘；细节 Skill 在下方独立绑定。'
                : '无窗口运行；配置同时应用于套版识别和 Skill 训练。'}</small>
          </div>
        </div>
        <div className="runtime-connection">
          <span className={`runtime-status ${connected ? 'is-connected' : 'is-offline'}`}>
            {connected ? <CheckCircle size={17} weight="fill" /> : <WarningCircle size={17} weight="fill" />}
            {loading ? '检查中' : connected ? 'Codex 已接入' : 'Codex 未接入'}
          </span>
          <button type="button" className="runtime-refresh" onClick={onRefresh} disabled={loading} aria-label="刷新 Codex 状态">
            <ArrowsClockwise size={17} weight="bold" />刷新
          </button>
        </div>
      </div>

      <div className="runtime-grid">
        {context === 'default' && (
          <label className="runtime-field runtime-field-skill">
            <span>训练 Skill</span>
            <select value={value.skillId} onChange={event => patch({ skillId: event.target.value })}>
              {(angleSkills.length ? angleSkills : [{ id: 'chair-angle-matcher', name: 'Chair Angle Matcher', description: '' }]).map(skill => (
                <option key={skill.id} value={skill.id}>{skill.name}</option>
              ))}
            </select>
          </label>
        )}

        {context !== 'default' && (
          <div className="runtime-field runtime-field-skill">
            <span>{context === 'verification' ? '绑定核验 Skill' : '绑定重绘 Skill'}</span>
            <div className={`runtime-skill-binding ${boundSkill ? 'is-ready' : 'is-missing'}`}>
              <strong>{boundSkill?.name || boundSkillId}</strong>
              <small>{boundSkill ? boundSkillId : 'Skill 目录尚未被后台发现'}</small>
            </div>
          </div>
        )}

        <label className="runtime-field runtime-field-provider">
          <span>模型供应商</span>
          <select value={value.providerId} onChange={event => patch({ providerId: event.target.value })}>
            {(status?.providers || [{ id: value.providerId, name: 'Codex', kind: 'codex-login' as const }]).map(provider => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
          <small><PlugsConnected size={14} weight="bold" />{selectedProvider?.kind === 'custom' ? '使用 Codex config.toml 中的自定义 Provider' : status?.authMethod || '等待后台检测'}</small>
        </label>

        <label className="runtime-field runtime-field-model">
          <span>{context === 'verification' ? '核验模型' : context === 'detail-redraw' ? '重绘模型' : '匹配模型'}</span>
          <select value={value.model} onChange={event => patch({ model: event.target.value })}>
            {(status?.models || [{ id: value.model, name: value.model, description: '' }]).map(model => (
              <option key={model.id} value={model.id}>{model.name}{model.id === status?.currentModel ? ' · 默认' : ''}</option>
            ))}
          </select>
        </label>

        <label className="runtime-field runtime-field-reasoning">
          <span>思考强度</span>
          <select value={value.reasoningEffort} onChange={event => patch({ reasoningEffort: event.target.value as RuntimeSelection['reasoningEffort'] })}>
            {(status?.reasoningEfforts || [{ id: value.reasoningEffort, name: value.reasoningEffort, description: '' }]).map(effort => (
              <option key={effort.id} value={effort.id}>{effort.name}</option>
            ))}
          </select>
        </label>
      </div>

      {status?.error && <div className="runtime-error"><WarningCircle size={16} weight="fill" />{status.error}</div>}
      {status?.available && <div className="runtime-footnote">{status.version} · 后台进程按任务启动，不依赖 Codex 窗口常驻。</div>}
    </section>
  )
}
