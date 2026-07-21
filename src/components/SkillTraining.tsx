import { useRef, useState } from 'react'
import { Brain, CheckCircle, Database, Flask, Play, ShieldCheck, WarningCircle } from '@phosphor-icons/react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import { recognizeAnglesWithCodexSkill } from '../api/client'
import type { CodexSkillRecognitionResponse, RuntimeSelection } from '../types'

interface Props {
  runtime: RuntimeSelection
  runtimeReady: boolean
}

export default function SkillTraining({ runtime, runtimeReady }: Props) {
  const pageRef = useRef<HTMLElement>(null)
  const [projectPath, setProjectPath] = useState(() => localStorage.getItem('scenecolor_training_path') || localStorage.getItem('scenecolor_folder_path') || '')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CodexSkillRecognitionResponse | null>(null)

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.training-stage', { autoAlpha: 0, y: 28, scale: 0.97 }, {
        autoAlpha: 1, y: 0, scale: 1, duration: 0.48, stagger: 0.09, ease: 'power3.out', clearProps: 'transform,opacity,visibility',
      })
    })
    return () => media.revert()
  }, { scope: pageRef })

  const runTraining = async () => {
    if (!projectPath.trim() || !runtimeReady || running) return
    localStorage.setItem('scenecolor_training_path', projectPath.trim())
    setRunning(true); setError(''); setResult(null)
    try {
      setResult(await recognizeAnglesWithCodexSkill(projectPath.trim(), runtime))
    } catch (exception: any) {
      setError(exception?.message || 'Skill 训练任务失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <main className="skill-training-page" ref={pageRef}>
      <section className="training-hero">
        <div>
          <span className="training-kicker"><Brain size={18} weight="bold" />规则训练与回归验证</span>
          <h1>训练 Skill，与生产套版工作台分开</h1>
          <p>这里运行数据校准、规则识别和锚点匹配；不会启动图片生成。当前选择的供应商、模型和思考强度由上方后台配置统一控制。</p>
        </div>
        <div className="training-skill-orbit" aria-hidden="true"><span>Skill</span><i /><i /></div>
      </section>

      <section className="training-runner training-stage">
        <div className="training-runner-copy">
          <strong>训练项目</strong>
          <small>目录需要包含 scenes、products 和对应的产品角度索引。</small>
        </div>
        <div className="training-path-row">
          <input aria-label="训练项目路径" placeholder="输入训练数据项目的绝对路径" value={projectPath} onChange={event => setProjectPath(event.target.value)} />
          <button type="button" onClick={runTraining} disabled={!projectPath.trim() || !runtimeReady || running}>
            {running ? <span className="spinner" /> : <Play size={17} weight="fill" />}
            {running ? '后台训练中' : '运行一轮训练'}
          </button>
        </div>
        {!runtimeReady && <small className="training-runtime-warning"><WarningCircle size={15} weight="fill" />请先接入可用的 Codex 后台。</small>}
      </section>

      <section className="training-stage-stack" aria-label="Skill 训练流程">
        <article className="training-stage stage-data">
          <span><Database size={22} weight="bold" /></span>
          <div><strong>训练数据</strong><p>读取场景图、产品素材和本地产品锚点；一次批量检查，不自动重试。</p></div>
        </article>
        <article className="training-stage stage-rules">
          <span><ShieldCheck size={22} weight="bold" /></span>
          <div><strong>Skill 规则</strong><p>独立加载角度、画面朝向、脚垫、遮挡、多椅与安全拒绝规则。</p></div>
        </article>
        <article className="training-stage stage-validation">
          <span><Flask size={22} weight="bold" /></span>
          <div><strong>回归验收</strong><p>将结构化识别结果交给确定性匹配器，保留自动、复核和阻止状态。</p></div>
        </article>
      </section>

      {error && <div className="error-banner"><WarningCircle size={18} weight="fill" />{error}</div>}
      {result?.summary && (
        <section className="training-result training-stage">
          <div><CheckCircle size={24} weight="fill" /><strong>本轮训练完成</strong><small>{result.recognition?.model} · {result.recognition?.reasoningEffort}</small></div>
          <dl>
            <div><dt>场景</dt><dd>{result.summary.sceneCount}</dd></div>
            <div><dt>自动匹配</dt><dd>{result.summary.autoCount}</dd></div>
            <div><dt>待复核</dt><dd>{result.summary.reviewCount}</dd></div>
            <div><dt>安全阻止</dt><dd>{result.summary.unmatchedCount}</dd></div>
          </dl>
        </section>
      )}
    </main>
  )
}
