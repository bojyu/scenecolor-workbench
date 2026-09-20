import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise, Brain, Check, CheckCircle, Database, Eye, FloppyDisk,
  FolderOpen, PencilSimple, ShieldCheck, WarningCircle,
} from '@phosphor-icons/react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  getThumbnailUrl,
  loadSkillResults,
  loadSkillTrainingReport,
  publishSkillTraining,
  recalculateSkillTraining,
} from '../api/client'
import type {
  AngleObservability,
  CodexSkillRecognitionResponse,
  CoarseDirection,
  FootrestCapability,
  FootrestState,
  RuntimeSelection,
  SceneAngle,
  SkillSceneResult,
  SkillTrainingReviewInput,
  SkillTrainingReport,
} from '../types'

interface Props {
  runtime: RuntimeSelection
  runtimeReady: boolean
}

type ReviewDraft = Omit<SkillTrainingReviewInput, 'reviewState'> & {
  reviewState?: 'confirmed' | 'corrected'
}

const PAGE_SIZE = 8
const ANGLES: Array<{ value: Exclude<SceneAngle, 'multiple' | 'unknown'>; label: string; azimuth: number }> = [
  { value: 'front', label: '正面', azimuth: 0 },
  { value: 'front_right', label: '右前斜', azimuth: 45 },
  { value: 'right', label: '右侧', azimuth: 90 },
  { value: 'back_right', label: '右后斜', azimuth: 135 },
  { value: 'back', label: '背面', azimuth: 180 },
  { value: 'back_left', label: '左后斜', azimuth: 225 },
  { value: 'left', label: '左侧', azimuth: 270 },
  { value: 'front_left', label: '左前斜', azimuth: 315 },
]

const angleLabel = (angle: SceneAngle) => ANGLES.find(item => item.value === angle)?.label
  ?? (angle === 'multiple' ? '多角度' : '未知')

function SceneThumbnail({ path }: { path: string }) {
  return <img src={getThumbnailUrl(path, 480)} alt="待复核场景" loading="lazy" decoding="async" />
}

function initialDraft(item: SkillSceneResult): ReviewDraft {
  return {
    scenePath: item.scenePath,
    angleObservability: item.angleObservability ?? (item.azimuth === null ? 'none' : 'exact'),
    coarseDirection: item.coarseDirection ?? 'unknown',
    azimuth: item.azimuth,
    sceneMode: item.sceneMode ?? 'single',
    footrest: { ...item.footrest },
    instances: item.instances?.flatMap(instance => instance.azimuth === null ? [] : [{
      id: instance.id,
      azimuth: instance.azimuth,
      confidence: instance.confidence,
      decisiveCue: instance.decisiveCue,
      reclineState: instance.reclineState,
      footrest: instance.footrest,
    }]),
    reviewerNote: '',
  }
}

export default function SkillTraining({ runtime, runtimeReady }: Props) {
  const pageRef = useRef<HTMLElement>(null)
  const projectPath = localStorage.getItem('scenecolor_folder_path') || ''
  const [running, setRunning] = useState(false)
  const [adjusting, setAdjusting] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<CodexSkillRecognitionResponse | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({})
  const [reviewId, setReviewId] = useState('')
  const [publishTarget, setPublishTarget] = useState<'skill' | 'database'>('database')
  const [publication, setPublication] = useState<{ corpusPath: string; writtenCount: number; totalCount: number } | null>(null)
  const [page, setPage] = useState(0)
  const [report, setReport] = useState<SkillTrainingReport | null>(null)

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.training-stage', { autoAlpha: 0, y: 24 }, {
        autoAlpha: 1, y: 0, duration: 0.42, stagger: 0.06, ease: 'power3.out', clearProps: 'transform,opacity,visibility',
      })
    })
    return () => media.revert()
  }, { scope: pageRef })

  const scenes = result?.sceneResults ?? []
  const reviewedCount = scenes.filter(item => drafts[item.scenePath]?.reviewState).length
  const correctedCount = scenes.filter(item => drafts[item.scenePath]?.reviewState === 'corrected').length
  const allReviewed = scenes.length > 0 && reviewedCount === scenes.length
  const pageCount = Math.max(1, Math.ceil(scenes.length / PAGE_SIZE))
  const visibleScenes = useMemo(() => scenes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [scenes, page])

  const markChanged = (scenePath: string, update: Partial<ReviewDraft>) => {
    setDrafts(current => ({
      ...current,
      [scenePath]: { ...current[scenePath], ...update, reviewState: 'corrected' },
    }))
    setReviewId('')
    setPublication(null)
  }

  const runRecognition = async () => {
    if (!projectPath.trim() || running) return
    setRunning(true); setError(''); setResult(null); setDrafts({}); setReviewId(''); setPublication(null); setPage(0)
    try {
      const [response, trainingReport] = await Promise.all([
        loadSkillResults(projectPath.trim()),
        loadSkillTrainingReport(projectPath.trim(), runtime),
      ])
      setResult(response)
      setDrafts(Object.fromEntries(response.sceneResults.map(item => [item.scenePath, initialDraft(item)])))
      setReport(trainingReport)
    } catch (exception: any) {
      setError(exception?.message || '工作台训练结果读取失败，请先在工作台完成角度识别')
    } finally {
      setRunning(false)
    }
  }

  const recalculate = async () => {
    if (!allReviewed || adjusting) return
    setAdjusting(true); setError(''); setPublication(null)
    try {
      const reviews = scenes.map(item => drafts[item.scenePath] as SkillTrainingReviewInput)
      const response = await recalculateSkillTraining(projectPath.trim(), runtime, reviews)
      setResult(response)
      setReviewId(response.review.reviewId)
    } catch (exception: any) {
      setError(exception?.message || '人工调整计算失败')
    } finally {
      setAdjusting(false)
    }
  }

  const publish = async () => {
    if (!reviewId || publishing) return
    setPublishing(true); setError('')
    try {
      const response = await publishSkillTraining(projectPath.trim(), reviewId, publishTarget)
      setPublication(response.publication)
      setReport(await loadSkillTrainingReport(projectPath.trim(), runtime))
    } catch (exception: any) {
      setError(exception?.message || '案例发布失败')
    } finally {
      setPublishing(false)
    }
  }

  return (
    <main className="skill-training-page" ref={pageRef}>
      <section className="training-hero training-stage">
        <div>
          <span className="training-kicker"><Brain size={18} weight="bold" />人机协作训练闭环</span>
          <h1>先识别，再逐图核对，最后沉淀为可追溯案例</h1>
          <p>模型只负责观察，人工负责最终标签。错误项调整后会重新执行确定性匹配；未经逐图复核的数据不能写入 Skill 或案例数据库。</p>
        </div>
        <div className="training-skill-orbit" aria-hidden="true"><span>Skill</span><i /><i /></div>
      </section>

      <section className="training-workflow training-stage" aria-label="Skill 训练流程">
        {[
          ['01', '套版文件夹', Boolean(result)],
          ['02', '工作台结果', Boolean(result)],
          ['03', '人工打标', allReviewed],
          ['04', '重新计算', Boolean(reviewId)],
          ['05', '写入案例库', Boolean(publication)],
        ].map(([number, label, complete], index) => (
          <div key={String(number)} className={`${complete ? 'is-complete' : ''} ${!complete && ((index === 0 && !result) || (index === 2 && result) || (index === 3 && allReviewed) || (index === 4 && reviewId)) ? 'is-active' : ''}`}>
            <span>{complete ? <Check size={15} weight="bold" /> : number}</span><strong>{label}</strong>
          </div>
        ))}
      </section>

      <section className="training-runner training-stage">
        <div className="training-runner-copy">
          <strong><FolderOpen size={18} weight="bold" />读取工作台训练结果</strong>
          <small>直接读取工作台识别、人工修正和参考图反馈，不会重新调用模型。</small>
        </div>
        <div className="training-path-row">
          <div className="training-current-project">
            <span>当前工作台项目</span>
            <strong title={projectPath}>{projectPath || '尚未在工作台选择项目'}</strong>
          </div>
          <button type="button" className="training-report-button" onClick={runRecognition} disabled={!projectPath.trim() || running}>
            {running ? <span className="spinner" /> : <Database size={17} weight="bold" />}
            {running ? '正在读取…' : result ? '刷新训练汇报' : '查看训练汇报'}
          </button>
        </div>
        {!projectPath.trim() && <small className="training-runtime-warning"><WarningCircle size={15} weight="fill" />请先在套版工作台选择项目并完成角度识别。</small>}
        {!runtimeReady && <small className="training-runtime-warning"><WarningCircle size={15} weight="fill" />请先接入可用的 Codex 后台。</small>}
      </section>

      {report && (
        <section className="training-report training-stage">
          <div className="training-report-heading">
            <div><Brain size={21} weight="bold" /><span><strong>Skill 训练汇报</strong><small>最近活动：{report.lastActivityAt ? new Date(report.lastActivityAt).toLocaleString() : '暂无'}</small></span></div>
            <span>{report.activeExampleCount > 0 ? '人工案例已进入下一轮识别' : '等待人工修正案例'}</span>
          </div>
          <dl className="training-report-metrics">
            <div><dt>项目案例</dt><dd>{report.projectCaseCount}</dd></div>
            <div><dt>Skill 案例</dt><dd>{report.skillCaseCount}</dd></div>
            <div><dt>角度修正</dt><dd>{report.inlineReviewCount}</dd></div>
            <div><dt>参考图偏好</dt><dd>{report.referencePreferenceCount}</dd></div>
            <div><dt>识别示例</dt><dd>{report.activeExampleCount}</dd></div>
          </dl>
          <div className="training-report-angles">
            <strong>人工修正角度分布</strong>
            {Object.keys(report.correctedByAngle).length
              ? Object.entries(report.correctedByAngle).map(([angle, count]) => <span key={angle}>{angleLabel(angle as SceneAngle)} · {count}</span>)
              : <small>暂无人工修正数据</small>}
          </div>
        </section>
      )}

      {error && <div className="error-banner"><WarningCircle size={18} weight="fill" />{error}</div>}

      {result?.summary && (
        <>
          <section className="training-review-heading training-stage">
            <div>
              <span><Eye size={22} weight="bold" /></span>
              <div><strong>逐图人工核对</strong><small>确认正确标签，或展开错误项进行调整。全部核对后才能重新计算。</small></div>
            </div>
            <dl>
              <div><dt>场景</dt><dd>{scenes.length}</dd></div>
              <div><dt>已核对</dt><dd>{reviewedCount}</dd></div>
              <div><dt>已调整</dt><dd>{correctedCount}</dd></div>
              <div><dt>缓存命中</dt><dd>{result.recognition?.cachedSceneCount ?? 0}</dd></div>
            </dl>
          </section>

          <section className="training-review-grid training-stage">
            {visibleScenes.map(item => {
              const draft = drafts[item.scenePath] ?? initialDraft(item)
              const isCorrected = draft.reviewState === 'corrected'
              return (
                <article key={item.scenePath} className={`training-review-card ${draft.reviewState ? `is-${draft.reviewState}` : ''}`}>
                  <div className="training-scene-preview"><SceneThumbnail path={item.scenePath} /></div>
                  <div className="training-card-head">
                    <div><strong>{item.scenePath.split(/[\\/]/).pop()}</strong><small>{item.decisiveCue}</small></div>
                    <span className={`training-prediction-status is-${item.status}`}>{item.status === 'auto' ? '自动' : item.status === 'review' ? '待复核' : '已阻止'}</span>
                  </div>
                  <div className="training-label-summary">
                    <span>角度<strong>{angleLabel(item.angle)}</strong></span>
                    <span>方位角<strong>{item.azimuth === null ? '—' : `${Math.round(item.azimuth)}°`}</strong></span>
                    <span>可观测性<strong>{item.angleObservability ?? '旧数据'}</strong></span>
                    <span>脚垫<strong>{item.footrest.state}</strong></span>
                  </div>
                  <div className="training-review-actions">
                    <button type="button" className={draft.reviewState === 'confirmed' ? 'is-selected' : ''} onClick={() => {
                      setDrafts(current => ({ ...current, [item.scenePath]: { ...current[item.scenePath], reviewState: 'confirmed' } }))
                      setReviewId(''); setPublication(null)
                    }}><CheckCircle size={16} weight="fill" />标签正确</button>
                    <button type="button" className={isCorrected ? 'is-selected' : ''} onClick={() => markChanged(item.scenePath, {})}>
                      <PencilSimple size={16} weight="bold" />需要调整
                    </button>
                  </div>
                  {isCorrected && (
                    <div className="training-editor">
                      <label>可观测性<select value={draft.angleObservability} onChange={event => markChanged(item.scenePath, { angleObservability: event.target.value as AngleObservability })}>
                        <option value="exact">exact · 精确</option><option value="coarse">coarse · 粗方向</option><option value="none">none · 不可判断</option>
                      </select></label>
                      {draft.angleObservability === 'exact' && draft.sceneMode === 'single' && <>
                        <label>语义角度<select value={ANGLES.find(angle => angle.azimuth === draft.azimuth)?.value ?? item.angle} onChange={event => {
                          const selected = ANGLES.find(angle => angle.value === event.target.value)
                          if (selected) markChanged(item.scenePath, { azimuth: selected.azimuth })
                        }}>{ANGLES.map(angle => <option key={angle.value} value={angle.value}>{angle.label}</option>)}</select></label>
                        <label>连续方位角<input type="number" min="0" max="359.9" step="1" value={draft.azimuth ?? ''} onChange={event => markChanged(item.scenePath, { azimuth: event.target.value === '' ? null : Number(event.target.value) })} /></label>
                      </>}
                      {draft.angleObservability === 'coarse' && <label>粗方向<select value={draft.coarseDirection} onChange={event => markChanged(item.scenePath, { coarseDirection: event.target.value as CoarseDirection })}>
                        <option value="front">前</option><option value="right">右</option><option value="back">后</option><option value="left">左</option><option value="unknown">未知</option>
                      </select></label>}
                      <label>脚垫能力<select value={draft.footrest?.capability} onChange={event => {
                        const capability = event.target.value as FootrestCapability
                        markChanged(item.scenePath, { footrest: { ...draft.footrest!, capability, state: capability === 'absent' ? 'not_applicable' : draft.footrest?.state === 'not_applicable' ? 'unknown' : draft.footrest!.state } })
                      }}><option value="present">存在</option><option value="absent">不存在</option><option value="unknown">未知</option></select></label>
                      <label>脚垫状态<select value={draft.footrest?.state} disabled={draft.footrest?.capability === 'absent'} onChange={event => markChanged(item.scenePath, { footrest: { ...draft.footrest!, state: event.target.value as FootrestState } })}>
                        <option value="retracted">收起</option><option value="partial">部分伸出</option><option value="extended">伸出</option><option value="not_applicable">不适用</option><option value="unknown">未知</option>
                      </select></label>
                      {draft.sceneMode === 'multi_same_model' && draft.instances?.map((instance, index) => (
                        <label key={instance.id}>椅子 {index + 1} 角度<select value={ANGLES.find(angle => angle.azimuth === instance.azimuth)?.value ?? 'front'} onChange={event => {
                          const selected = ANGLES.find(angle => angle.value === event.target.value)
                          if (!selected) return
                          const instances = [...(draft.instances ?? [])]
                          instances[index] = { ...instances[index], azimuth: selected.azimuth }
                          markChanged(item.scenePath, { instances })
                        }}>{ANGLES.map(angle => <option key={angle.value} value={angle.value}>{angle.label}</option>)}</select></label>
                      ))}
                      <label className="training-note">调整说明<textarea value={draft.reviewerNote} placeholder="简要记录为什么修改" onChange={event => markChanged(item.scenePath, { reviewerNote: event.target.value })} /></label>
                    </div>
                  )}
                </article>
              )
            })}
          </section>

          <div className="training-pagination training-stage">
            <button type="button" onClick={() => setPage(value => Math.max(0, value - 1))} disabled={page === 0}>上一页</button>
            <span>第 {page + 1} / {pageCount} 页</span>
            <button type="button" onClick={() => setPage(value => Math.min(pageCount - 1, value + 1))} disabled={page >= pageCount - 1}>下一页</button>
          </div>

          <section className="training-adjust-panel training-stage">
            <div><ShieldCheck size={23} weight="bold" /><span><strong>识别调整与重新匹配</strong><small>{allReviewed ? `已核对 ${reviewedCount} 张，其中 ${correctedCount} 张已人工调整。` : `还需核对 ${scenes.length - reviewedCount} 张场景。`}</small></span></div>
            <button type="button" onClick={recalculate} disabled={!allReviewed || adjusting}>
              {adjusting ? <span className="spinner" /> : <ArrowClockwise size={17} weight="bold" />}{adjusting ? '正在重新计算…' : '应用人工标签并重新计算'}
            </button>
          </section>

          {reviewId && (
            <section className="training-publish-panel training-stage">
              <div className="training-publish-copy"><FloppyDisk size={24} weight="bold" /><span><strong>发布已审核案例</strong><small>发布只写入结构化案例，不自动修改 Skill 规则正文。</small></span></div>
              <div className="training-targets">
                <button type="button" className={publishTarget === 'database' ? 'is-selected' : ''} onClick={() => setPublishTarget('database')}><Database size={19} weight="bold" /><span><strong>本地案例数据库</strong><small>写入当前项目 .scenecolor/case-corpus</small></span></button>
                <button type="button" className={publishTarget === 'skill' ? 'is-selected' : ''} onClick={() => setPublishTarget('skill')}><Brain size={19} weight="bold" /><span><strong>Skill 案例库</strong><small>写入 Skill references/training-cases.jsonl</small></span></button>
              </div>
              <button type="button" className="training-publish-button" onClick={publish} disabled={publishing}>
                {publishing ? <span className="spinner" /> : <FloppyDisk size={17} weight="fill" />}{publishing ? '正在写入…' : '写入已审核案例'}
              </button>
            </section>
          )}

          {publication && <section className="training-result training-stage">
            <div><CheckCircle size={24} weight="fill" /><strong>案例写入完成</strong><small>{publication.corpusPath}</small></div>
            <dl><div><dt>本次写入</dt><dd>{publication.writtenCount}</dd></div><div><dt>案例总数</dt><dd>{publication.totalCount}</dd></div></dl>
          </section>}
        </>
      )}
    </main>
  )
}
