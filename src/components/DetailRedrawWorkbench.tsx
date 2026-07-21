import { useRef } from 'react'
import gsap from 'gsap'
import { useGSAP } from '@gsap/react'
import {
  ArrowLeft,
  CheckCircle,
  ClockCountdown,
  Crop,
  ImageSquare,
  MagnifyingGlass,
  PaintBrushBroad,
  Robot,
  SlidersHorizontal,
  Stack,
  Trash,
} from '@phosphor-icons/react'
import type { DetailRedrawQueueItem, DetailRedrawTarget, RuntimeSelection } from '../types'
import TaskProgress from './TaskProgress'

interface Props {
  runtime: RuntimeSelection
  runtimeReady: boolean
  items: DetailRedrawQueueItem[]
  onRemove: (id: string) => void
  onBackToVerification: () => void
  onUpdateTargets: (id: string, targets: DetailRedrawTarget[]) => void
}

const TARGETS: Array<{ id: DetailRedrawTarget; label: string; description: string }> = [
  { id: 'logo', label: '品牌 Logo', description: '文字、图形标识与准确位置' },
  { id: 'stitching', label: '缝线', description: '走线方向、针距和接缝关系' },
  { id: 'piping', label: '滚边包边', description: '边缘轮廓与材质过渡' },
  { id: 'texture', label: '面料纹理', description: '局部织物、皮革和高光细节' },
  { id: 'hardware', label: '五金结构', description: '螺丝、连接件与塑料装饰件' },
  { id: 'other', label: '其他细节', description: '由智能体补充识别的异常区域' },
]

const PIPELINE = [
  { title: '智能定位', copy: 'Codex 对照成图与素材，输出局部目标、边界框和判断证据。', icon: MagnifyingGlass },
  { title: '安全裁切', copy: '按边界框增加上下文留白，保留坐标、尺寸和回贴锚点。', icon: Crop },
  { title: '局部重绘', copy: '细节 Skill 只处理裁切区域，恢复 Logo、缝线、纹理和五金。', icon: PaintBrushBroad },
  { title: '无缝合成', copy: '使用掩膜把修复块合成回原尺寸图片，再执行边缘与一致性复核。', icon: Stack },
]

function shortName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

function queuedTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '刚刚发送'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

export default function DetailRedrawWorkbench({ runtime, runtimeReady, items, onRemove, onBackToVerification, onUpdateTargets }: Props) {
  const pageRef = useRef<HTMLDivElement>(null)

  const configuredCount = items.filter(item => item.requestedTargets.length > 0).length
  const waitingCount = items.filter(item => item.progress.status === 'queued').length
  const completedCount = items.filter(item => item.progress.status === 'completed').length

  const toggleTarget = (item: DetailRedrawQueueItem, target: DetailRedrawTarget) => {
    const next = item.requestedTargets.includes(target)
      ? item.requestedTargets.filter(value => value !== target)
      : [...item.requestedTargets, target]
    onUpdateTargets(item.id, next)
  }

  useGSAP(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo('.detail-reveal', { autoAlpha: 0, y: 15 }, {
        autoAlpha: 1, y: 0, duration: 0.38, stagger: 0.06, ease: 'power2.out', clearProps: 'transform,opacity,visibility',
      })
      const redrawCards = gsap.utils.toArray<HTMLElement>('.detail-redraw-card')
      if (redrawCards.length) {
        gsap.fromTo(redrawCards, { autoAlpha: 0, y: 13 }, {
          autoAlpha: 1, y: 0, duration: 0.34, stagger: 0.055, delay: 0.14, ease: 'power2.out', clearProps: 'transform,opacity,visibility',
        })
      }
    })
    return () => media.revert()
  }, { scope: pageRef, dependencies: [items.length], revertOnUpdate: true })

  return (
    <div className="detail-redraw-page" ref={pageRef}>
      <section className="detail-redraw-hero detail-reveal">
        <div className="detail-redraw-hero-copy">
          <span className="detail-redraw-kicker"><PaintBrushBroad size={17} weight="fill" />来自核验工作台</span>
          <h1>把整体生成遗漏的细节，精准修回原图</h1>
          <p>独立的 chair-detail-restorer Skill 将让 Codex 智能体识别 Logo、缝线、包边、纹理和五金位置，按坐标裁切局部、重绘细节并无缝合成回原始场景图。</p>
          <button type="button" onClick={onBackToVerification}><ArrowLeft size={18} weight="bold" />返回核验结果</button>
        </div>
        <div className="detail-redraw-skill-card">
          <div className="detail-redraw-skill-heading">
            <span><Robot size={23} weight="bold" /></span>
            <div><small>独立细节 Skill</small><strong>chair-detail-restorer</strong><p>{runtimeReady ? `${runtime.model} · ${runtime.reasoningEffort}` : 'Codex 后台尚未接入'}</p></div>
          </div>
          <div className="detail-redraw-crop-demo" aria-label="局部识别和裁切示意">
            <div className="detail-demo-image"><ImageSquare size={34} weight="duotone" /><i className="detail-demo-box is-logo">Logo</i><i className="detail-demo-box is-stitch">缝线</i></div>
            <div className="detail-demo-crop"><Crop size={24} weight="bold" /><span>局部裁切</span></div>
            <div className="detail-demo-result"><PaintBrushBroad size={28} weight="duotone" /><span>重绘并回贴</span></div>
          </div>
        </div>
      </section>

      <section className="detail-pipeline detail-reveal" aria-label="细节重绘流程">
        {PIPELINE.map((stage, index) => {
          const Icon = stage.icon
          return <article key={stage.title}><span><Icon size={21} weight="bold" /></span><div><small>{index + 1}</small><strong>{stage.title}</strong><p>{stage.copy}</p></div></article>
        })}
      </section>

      <section className="detail-redraw-metrics detail-reveal" aria-label="细节重绘统计">
        <article><small>已接收</small><strong>{items.length}</strong><p>核验工作台确认结果</p></article>
        <article><small>已配置目标</small><strong>{configuredCount}</strong><p>选择了局部修复内容</p></article>
        <article><small>等待定位</small><strong>{waitingCount}</strong><p>尚未调用 Codex 智能体</p></article>
        <article><small>完成合成</small><strong>{completedCount}</strong><p>输出保持原图尺寸</p></article>
      </section>

      <section className="detail-redraw-queue detail-reveal">
        <div className="detail-section-heading">
          <div><span><SlidersHorizontal size={20} weight="bold" /></span><div><h2>待重绘任务</h2><p>为每张图选择需要重点恢复的内容；智能体仍会检查其他明显异常。</p></div></div>
          {items.length > 0 && <small>{items.length} 张待处理</small>}
        </div>

        {items.length > 0 ? (
          <div className="detail-redraw-list">
            {items.map(item => {
              const selectedTargets = item.requestedTargets
              return (
                <article className="detail-redraw-card" key={item.id}>
                  <div className="detail-card-preview">
                    <div className="detail-card-image">
                      {item.verifiedImage ? <img src={item.verifiedImage} alt={`${shortName(item.scenePath)} 待细节重绘图片`} /> : <ImageSquare size={42} weight="duotone" />}
                      <span><ClockCountdown size={15} weight="bold" />{item.progress.stageLabel}</span>
                    </div>
                    <div className="detail-card-source">
                      <figure>{item.productImage ? <img src={item.productImage} alt="匹配素材" /> : <Stack size={27} weight="duotone" />}<figcaption>产品素材</figcaption></figure>
                      <figure>{item.sceneImage ? <img src={item.sceneImage} alt="原场景" /> : <ImageSquare size={27} weight="duotone" />}<figcaption>原场景</figcaption></figure>
                    </div>
                  </div>

                  <div className="detail-card-content">
                    <div className="detail-card-topline">
                      <div><small>{queuedTime(item.queuedAt)} 从核验工作台发送</small><strong>{shortName(item.scenePath)}</strong><p>{shortName(item.productPath)} · v{item.version}</p></div>
                      <button type="button" onClick={() => onRemove(item.id)} aria-label={`移除 ${shortName(item.scenePath)} 的细节重绘任务`}><Trash size={17} weight="bold" />移除</button>
                    </div>

                    <div className="detail-target-panel">
                      <div><strong>重点修复内容</strong><small>可多选，位置由 Codex 智能体自动识别</small></div>
                      <div className="detail-target-grid">
                        {TARGETS.map(target => {
                          const selected = selectedTargets.includes(target.id)
                          return <button type="button" key={target.id} className={selected ? 'is-selected' : ''} aria-pressed={selected} onClick={() => toggleTarget(item, target.id)}><span>{selected && <CheckCircle size={15} weight="fill" />}{target.label}</span><small>{target.description}</small></button>
                        })}
                      </div>
                    </div>

                    <TaskProgress progress={item.progress} />

                    <div className="detail-agent-plan">
                      <strong>智能体执行框架</strong>
                      <div><span>识别位置</span><i /><span>保存坐标</span><i /><span>裁切重绘</span><i /><span>合成复核</span></div>
                      <p>Skill 已包含区域 Schema、素材索引、坐标裁切、掩膜、回贴与掩膜外保护校验；接入执行 API 后按此流程写入产物。</p>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        ) : (
          <div className="detail-redraw-empty">
            <span><PaintBrushBroad size={32} weight="duotone" /></span>
            <strong>还没有需要细节重绘的图片</strong>
            <p>先在核验工作台确认一张结果，然后点击“确认并发送细节重绘”，图片及其素材关系会一起进入这里。</p>
            <button type="button" onClick={onBackToVerification}><ArrowLeft size={17} weight="bold" />返回核验工作台</button>
          </div>
        )}
      </section>

      <footer className="detail-redraw-action detail-reveal">
        <div><strong>{items.length ? `已准备 ${items.length} 个细节重绘任务` : '等待核验工作台发送结果'}</strong><p>chair-detail-restorer、区域 Schema 与确定性脚本已就绪；下一步接入局部图像编辑执行 API。</p></div>
        <button type="button" disabled><Robot size={18} weight="bold" />重绘执行 API 待接入</button>
      </footer>
    </div>
  )
}
