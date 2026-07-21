import { useEffect, useState } from 'react'
import { Key, Plus, Trash, X } from '@phosphor-icons/react'

interface Props {
  apiKeys: string[]
  onSave: (keys: string[]) => void
  onClose: () => void
}

export default function SettingsModal({ apiKeys, onSave, onClose }: Props) {
  // Init with existing keys, pad to at least 3 slots
  const init = apiKeys.length > 0 ? [...apiKeys] : ['', '', '']
  const [slots, setSlots] = useState<string[]>(init)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleSave = () => {
    const keys = slots.map(k => k.trim()).filter(k => k.length > 0)
    onSave(keys)
    onClose()
  }

  const setSlot = (i: number, val: string) => {
    setSlots(prev => {
      const next = [...prev]
      next[i] = val
      return next
    })
  }

  const addSlot = () => setSlots(prev => [...prev, ''])
  const removeSlot = (i: number) => {
    setSlots(prev => {
      if (prev.length <= 1) return prev
      return prev.filter((_, idx) => idx !== i)
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-heading">
          <span className="modal-heading-icon"><Key size={21} weight="bold" aria-hidden="true" /></span>
          <div><h2 id="settings-title">API Key 管理</h2><p>只在主动识别或生成时使用。</p></div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="关闭设置"><X size={18} weight="bold" /></button>
        </div>

        <div className="key-list">
          {slots.map((key, i) => (
            <div key={i} className="key-row">
              <span className="key-index">{i + 1}</span>
              <input
                className="key-input"
                type="password"
                aria-label={`API Key ${i + 1}`}
                placeholder="sk-..."
                value={key}
                onChange={(e) => setSlot(i, e.target.value)}
              />
              {slots.length > 1 && (
                <button type="button" className="key-remove-btn" onClick={() => removeSlot(i)} title="删除">
                  <Trash size={17} weight="bold" aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>

        <button type="button" className="key-add-btn" onClick={addSlot}>
          <Plus size={17} weight="bold" aria-hidden="true" />添加 Key
        </button>

        <p className="key-hint">
          {slots.filter(k => k.trim()).length} 个有效 Key，生成时平均分配请求，并发数 = Key 数量
        </p>

        <div className="modal-actions">
          <button type="button" className="btn-cancel" onClick={onClose}>取消</button>
          <button type="button" className="btn-save" onClick={handleSave}>保存</button>
        </div>
      </div>
    </div>
  )
}
