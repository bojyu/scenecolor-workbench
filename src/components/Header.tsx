import { FolderOpen, GearSix, GraduationCap, PaintBrushBroad, ShieldCheck } from '@phosphor-icons/react'

export type AppMode = 'workbench' | 'verification' | 'detail-redraw' | 'training'

interface HeaderProps {
  mode: AppMode
  onModeChange: (m: AppMode) => void
  onSettingsClick: () => void
  keyCount: number
  verificationCount: number
  detailRedrawCount: number
}

export default function Header({ mode, onModeChange, onSettingsClick, keyCount, verificationCount, detailRedrawCount }: HeaderProps) {
  return (
    <header className="header">
      <div className="header-left">
        <span className="brand-mark" aria-hidden="true">SC</span>
        <span className="header-brand-copy">
          <strong className="header-logo">SceneColor</strong>
          <small>图片套版工作台</small>
        </span>
      </div>
      <div className="header-right">
        <div className="mode-toggle" role="group" aria-label="工作模式">
          <button
            type="button"
            className={`mode-btn ${mode === 'workbench' ? 'active' : ''}`}
            onClick={() => onModeChange('workbench')}
          >
            <FolderOpen size={17} weight="bold" aria-hidden="true" />
            套版工作台
          </button>
          <button
            type="button"
            className={`mode-btn ${mode === 'verification' ? 'active' : ''}`}
            onClick={() => onModeChange('verification')}
          >
            <ShieldCheck size={17} weight="bold" aria-hidden="true" />
            生成核验
            {verificationCount > 0 && <span className="mode-count" aria-label={`${verificationCount} 个待核验任务`}>{verificationCount}</span>}
          </button>
          <button
            type="button"
            className={`mode-btn ${mode === 'detail-redraw' ? 'active' : ''}`}
            onClick={() => onModeChange('detail-redraw')}
          >
            <PaintBrushBroad size={17} weight="bold" aria-hidden="true" />
            细节重绘
            {detailRedrawCount > 0 && <span className="mode-count is-detail" aria-label={`${detailRedrawCount} 个待重绘任务`}>{detailRedrawCount}</span>}
          </button>
          <button
            type="button"
            className={`mode-btn ${mode === 'training' ? 'active' : ''}`}
            onClick={() => onModeChange('training')}
          >
            <GraduationCap size={17} weight="bold" aria-hidden="true" />
            Skill 训练
          </button>
        </div>
        <button
          type="button"
          className={`settings-btn ${keyCount > 0 ? 'has-key' : ''}`}
          onClick={onSettingsClick}
        >
          <GearSix size={18} weight="bold" aria-hidden="true" />
          {keyCount > 0 ? `${keyCount} 个 Key` : '设置 Key'}
        </button>
      </div>
    </header>
  )
}
