import { useRef, useState } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  ClockCountdown,
  ImageSquare,
  Robot,
  ShieldCheck,
  SlidersHorizontal,
  Stack,
  Trash,
} from '@phosphor-icons/react'
import type { DetailRedrawQueueItem, RuntimeSelection, VerificationQueueItem } from '../types'
import TaskProgress from './TaskProgress'
import { createDetailRedrawProgress, updateWorkflowProgress } from '../lib/workflowProgress'
import { getResultDownloadUrl, runVerification } from '../api/client'

interface Props {
  runtime: RuntimeSelection
  runtimeReady: boolean
  items: VerificationQueueItem[]
  onRemove: (id: string) => void
  onUpdate: (id: string, patch: Partial<VerificationQueueItem>) => void
  onBackToWorkbench: () => void
  onSendToDetailRedraw: (item: DetailRedrawQueueItem) => void
  detailRedrawQueuedIds: Set<string>
}

const CRITERIA = [
  { key: 'identity', title: '款式身份', copy: '核对靠背轮廓、扶手造型、坐垫比例和头枕组合，优先拦截错款。', signal: '关键结构特征' },
  { key: 'material', title: '颜色材质', copy: '比较主色、拼色区域、面料纹理和高光特征，避免颜色或材质跑偏。', signal: '颜色与纹理证据' },
  { key: 'structure', title: '结构完整', copy: '检查脚垫、底盘、滚轮、支撑件和缝线，识别缺失、融合与生成变形。', signal: '部件完整性' },
  { key: 'perspective', title: '角度透视', copy: '确认生成椅子的朝向、尺度、落地关系和透视与原场景保持一致。', signal: '空间几何一致性' },
  { key: 'scene', title: '场景保护', copy: '对照原场景，检查背景、人物、光影和其他物品是否被意外修改。', signal: '非目标区域变化' },
] as const

function shortName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

function queuedTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '刚刚发送'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const VERDICT_LABELS = {
  pass: '通过',
  detail_repair: '进入细节修复',
  regenerate: '需要整体重生成',
  manual_review: '需要人工复核',
} as const

export default function VerificationWorkbench({ runtime, runtimeReady, items, onRemove, onUpdate, onBackToWorkbench, onSendToDetailRedraw, detailRedrawQueuedIds }: Props) {
  const [activeCriterion, setActiveCriterion] = useState<string>('identity')
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set())
  const pageRef = useRef<HTMLDivElement>(null)
  const readyCount = items.filter(item => Boolean((item.savedPath || item.outputImage) && item.productPath && item.scenePath)).length
  const multiViewCount = items.filter(item => item.supportingProductPaths.length > 0).length
  const waitingCount = items.filter(item => item.progress.status === 'queued').length
  const completedCount = items.filter(item => item.progress.status === 'completed').length

  const startVerification = async (item: VerificationQueueItem) => {
    if (!item.attemptId || runningIds.has(item.id)) return
    setRunningIds(previous => new Set(previous).add(item.id))
    const runningProgress = updateWorkflowProgress(item.progress, {
      status: 'running',
      stage: 'verifying',
      stageLabel: '独立核验中',
      percent: 55,
    })
    onUpdate(item.id, {
      verificationError: undefined,
      progress: runningProgress,
    })
    try {
      const result = await runVerification(item.attemptId, runtime, item.scenePath)
      onUpdate(item.id, {
        verdict: result.verdict,
        verificationRunId: result.runId,
        verificationError: undefined,
        progress: updateWorkflowProgress(runningProgress, {
          status: 'waiting-review',
          stage: 'review',
          stageLabel: VERDICT_LABELS[result.verdict.verdict],
          percent: 90,
        }),
      })
    } catch (error: any) {
      onUpdate(item.id, {
        verificationError: error?.message || '核验失败',
        progress: updateWorkflowProgress(runningProgress, {
          status: 'failed',
          stage: 'verifying',
          stageLabel: '核验失败',
          percent: 55,
          error: error?.message || '核验失败',
        }),
      })
    } finally {
      setRunningIds(previous => {
        const next = new Set(previous)
        next.delete(item.id)
        return next
      })
    }
  }

  const sendToDetailRedraw = (item: VerificationQueueItem) => {
    if (!item.savedPath && !item.outputImage) return
    const queuedAt = new Date().toISOString()
    onSendToDetailRedraw({
      id: `detail|${item.id}`,
      sourceVerificationId: item.id,
      scenePath: item.scenePath,
      productPath: item.productPath,
      supportingProductPaths: item.supportingProductPaths,
      verifiedImage: item.outputImage,
      sceneImage: item.sceneImage,
      productImage: item.productImage,
      verifiedPreviewUrl: item.outputPreviewUrl,
      scenePreviewUrl: item.scenePreviewUrl,
      productPreviewUrl: item.productPreviewUrl,
      savedPath: item.savedPath,
      version: item.version,
      requestedTargets: [],
      queuedAt,
      progress: createDetailRedrawProgress(queuedAt),
    })
  }

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.verification-reveal', { autoAlpha: 0, y: 14 }, {
        autoAlpha: 1,
        y: 0,
        duration: 0.36,
        stagger: 0.055,
        ease: 'power2.out',
        clearProps: 'transform,opacity,visibility',
      })
      const queueCards = gsap.utils.toArray<HTMLElement>('.verification-queue-card')
      if (queueCards.length) {
        gsap.fromTo(queueCards, { autoAlpha: 0, y: 12 }, {
          autoAlpha: 1,
          y: 0,
          duration: 0.32,
          stagger: 0.05,
          delay: 0.12,
          ease: 'power2.out',
          clearProps: 'transform,opacity,visibility',
        })
      }
    })
    return () => media.revert()
  }, { scope: pageRef, dependencies: [items.length], revertOnUpdate: true })

  return (
    <div className="verification-page verification-linked-page" ref={pageRef}>
      <section className="verification-hero verification-linked-hero verification-reveal">
        <div className="verification-hero-copy">
          <span className="verification-kicker"><ShieldCheck size={17} weight="fill" />来自套版工作台</span>
          <h1>待核验队列</h1>
          <p>这里只接收你在套版结果中确认并发送的图片。每个任务会保留生成图、原场景、实际匹配素材和版本关系，再交给独立核验 Skill 判断。</p>
          <button type="button" className="verification-secondary-action" onClick={onBackToWorkbench}>
            <ArrowLeft size={18} weight="bold" />返回套版结果
          </button>
        </div>

        <div className="verification-linked-summary">
          <div className="verification-linked-skill">
            <span><Robot size={22} weight="bold" /></span>
            <div><small>独立核验 Skill</small><strong>chair-result-verifier</strong><p>{runtimeReady ? `${runtime.model} · ${runtime.reasoningEffort}` : 'Codex 后台尚未接入'}</p></div>
          </div>
          <div className="verification-handoff" aria-label="套版结果到核验的联动流程">
            <div className="is-complete"><span><CheckCircle size={18} weight="fill" /></span><strong>生成完成</strong><small>套版工作台</small></div>
            <ArrowRight size={16} aria-hidden="true" />
            <div className={items.length ? 'is-complete' : ''}><span><CheckCircle size={18} weight="fill" /></span><strong>人工确认</strong><small>发送核验</small></div>
            <ArrowRight size={16} aria-hidden="true" />
            <div className={items.length ? 'is-active' : ''}><span><ShieldCheck size={18} weight="bold" /></span><strong>核验队列</strong><small>{items.length} 个任务</small></div>
          </div>
        </div>
      </section>

      <section className="verification-metrics verification-reveal" aria-label="核验队列统计">
        <article><span><ImageSquare size={20} weight="bold" /></span><div><small>已接收</small><strong>{items.length}</strong><p>来自套版工作台</p></div></article>
        <article><span><CheckCircle size={20} weight="fill" /></span><div><small>资料完整</small><strong>{readyCount}</strong><p>生成图、场景与素材</p></div></article>
        <article><span><Stack size={20} weight="bold" /></span><div><small>多视图素材</small><strong>{multiViewCount}</strong><p>附带辅助参考图</p></div></article>
        <article><span><ClockCountdown size={20} weight="bold" /></span><div><small>等待核验</small><strong>{waitingCount}</strong><p>{completedCount ? `${completedCount} 个已发送重绘` : '尚未调用核验 Skill'}</p></div></article>
      </section>

      <section className="verification-queue verification-reveal">
        <div className="verification-section-heading verification-queue-heading">
          <div><span><ShieldCheck size={20} weight="bold" /></span><div><h2>工作台传入的结果</h2><p>确认无误后再开始核验；移除任务不会删除已经生成的图片。</p></div></div>
          {items.length > 0 && <small>{items.length} 个待核验</small>}
        </div>

        {items.length > 0 ? (
          <div className="verification-queue-list">
            {items.map(item => (
              <article className="verification-queue-card" key={item.id}>
                <div className="verification-queue-topline">
                  <div>
                    <span className={`verification-status is-${item.progress.status}`}><ClockCountdown size={16} weight="bold" />{item.progress.stageLabel}</span>
                    <small>{queuedTime(item.queuedAt)} 从套版工作台发送</small>
                  </div>
                  <button type="button" onClick={() => onRemove(item.id)} aria-label={`移除 ${shortName(item.scenePath)} 的核验任务`}><Trash size={17} weight="bold" />移除</button>
                </div>

                <div className="verification-linked-compare">
                  <figure>
                    <div>{item.outputPreviewUrl || item.outputImage ? <img src={item.outputPreviewUrl || item.outputImage} alt={`${shortName(item.scenePath)} 生成结果`} loading="lazy" decoding="async" /> : <ImageSquare size={30} weight="duotone" />}</div>
                    <figcaption><strong>生成结果</strong><small>{item.savedPath ? shortName(item.savedPath) : `版本 ${item.version}`}</small></figcaption>
                  </figure>
                  <figure>
                    <div>{item.productPreviewUrl || item.productImage ? <img src={item.productPreviewUrl || item.productImage} alt={`${shortName(item.productPath)} 匹配素材`} loading="lazy" decoding="async" /> : <Stack size={30} weight="duotone" />}</div>
                    <figcaption><strong>匹配素材</strong><small>{shortName(item.productPath)}</small></figcaption>
                  </figure>
                  <figure>
                    <div>{item.scenePreviewUrl || item.sceneImage ? <img src={item.scenePreviewUrl || item.sceneImage} alt={`${shortName(item.scenePath)} 原场景`} loading="lazy" decoding="async" /> : <ImageSquare size={30} weight="duotone" />}</div>
                    <figcaption><strong>原场景</strong><small>{shortName(item.scenePath)}</small></figcaption>
                  </figure>
                </div>

                <div className="verification-queue-meta">
                  <div><small>场景</small><strong>{shortName(item.scenePath)}</strong></div>
                  <div><small>素材</small><strong>{shortName(item.productPath)}</strong></div>
                  <div><small>生成版本</small><strong>v{item.version}</strong></div>
                  <div><small>辅助视图</small><strong>{item.supportingProductPaths.length} 张</strong></div>
                </div>
                <TaskProgress progress={item.progress} />
                <div className="verification-queue-transfer">
                  <div>
                    <strong>{item.verdict ? VERDICT_LABELS[item.verdict.verdict] : '运行独立核验'}</strong>
                    <small>
                      {item.verdict
                        ? `${item.verdict.summary}（置信度 ${Math.round(item.verdict.confidence * 100)}%）`
                        : item.attemptId
                          ? '将使用生成时冻结的原场景、产品素材和输出图进行独立判断。'
                          : '这是旧任务，缺少生成尝试记录；请返回工作台重新生成后再核验。'}
                    </small>
                    {item.verificationError && <small>{item.verificationError}</small>}
                    {item.verdict?.issues.map(issue => (
                      <small key={issue.id}>· {issue.evidence.observation} → {issue.action}</small>
                    ))}
                    {item.verdict?.uncertainties.map((uncertainty, index) => (
                      <small key={`${item.id}-uncertainty-${index}`}>· 待确认：{uncertainty}</small>
                    ))}
                  </div>
                  {item.savedPath && <a className="result-file-link" href={getResultDownloadUrl(item.savedPath)}>下载落盘原图</a>}
                  <button
                    type="button"
                    disabled={!runtimeReady || !item.attemptId || runningIds.has(item.id)}
                    onClick={() => startVerification(item)}
                  >
                    <Robot size={17} weight="bold" />
                    {runningIds.has(item.id) ? '核验中…' : item.verdict ? '重新核验' : '开始核验'}
                  </button>
                </div>
                <div className="verification-queue-transfer">
                  <div><strong>核验后的安全路由</strong><small>{item.verdict?.verdict === 'detail_repair' ? '该结果仅有局部细节问题，可以进入细节重绘。' : '只有核验明确判定为局部修复，才允许进入细节重绘。'}</small></div>
                  <button
                    type="button"
                    className={detailRedrawQueuedIds.has(`detail|${item.id}`) ? 'is-sent' : ''}
                    disabled={detailRedrawQueuedIds.has(`detail|${item.id}`) || (!item.savedPath && !item.outputImage) || item.verdict?.verdict !== 'detail_repair'}
                    onClick={() => sendToDetailRedraw(item)}
                  >
                    {detailRedrawQueuedIds.has(`detail|${item.id}`) ? <CheckCircle size={17} weight="fill" /> : <ArrowRight size={17} weight="bold" />}
                    {detailRedrawQueuedIds.has(`detail|${item.id}`) ? '已发送细节重绘' : item.verdict?.verdict === 'detail_repair' ? '发送细节重绘' : '等待核验路由'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="verification-empty verification-linked-empty">
            <span><ShieldCheck size={30} weight="duotone" /></span>
            <strong>核验队列还是空的</strong>
            <p>先在套版工作台完成生成，人工确认结果后点击“确认并发送核验”，任务会连同场景和素材关系一起出现在这里。</p>
            <button type="button" onClick={onBackToWorkbench}><ArrowLeft size={17} weight="bold" />返回套版工作台</button>
          </div>
        )}
      </section>

      <section className="verification-criteria-panel verification-reveal">
        <div className="verification-section-heading">
          <div><span><SlidersHorizontal size={20} weight="bold" /></span><div><h2>核验 Skill 将检查这些内容</h2><p>规则只在点击开始核验后执行，不参与前面的素材匹配和图片生成。</p></div></div>
          <small>独立后置核验</small>
        </div>
        <div className="verification-criteria">
          {CRITERIA.map(item => (
            <button key={item.key} type="button" className={activeCriterion === item.key ? 'is-active' : ''} onClick={() => setActiveCriterion(item.key)}>
              <span>{item.title}</span><strong>{item.signal}</strong><p>{item.copy}</p>
            </button>
          ))}
        </div>
      </section>

      <footer className="verification-action verification-reveal">
        <div><strong>{items.length ? `已准备 ${readyCount} 个核验任务` : '等待套版工作台发送结果'}</strong><p>{items.length ? 'chair-result-verifier 现在按任务独立调用，并将结论持久化到当前队列。' : '核验工作台不再重复扫描项目，只处理已经确认的套版结果。'}</p></div>
        <button type="button" disabled><Robot size={18} weight="bold" />{items.length ? '逐项运行核验' : '核验 Skill 已就绪'}</button>
      </footer>
    </div>
  )
}
